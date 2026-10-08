import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {once} from 'node:events';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {createHash, randomUUID} from 'node:crypto';

// A real signed discovery/code/PKCE protocol fixture; no stubbed token validation.
export async function createIssuer(tls) {
  const key = await generateKeyPair('RS256');
  const rogue = await generateKeyPair('RS256');
  const jwk = {...await exportJWK(key.publicKey), kid:'fixture', alg:'RS256', use:'sig'};
  let origin, scenario = {}, exchanges = 0;
  const codes = new Map();
  const handler = async (req, res) => {
    const url = new URL(req.url, origin);
    const json = data => {res.writeHead(200, {'content-type':'application/json'});res.end(JSON.stringify(data));};
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return json({issuer:origin,
      authorization_endpoint:origin+'/authorize', token_endpoint:origin+'/token', jwks_uri:origin+'/jwks',
      response_types_supported:['code'], subject_types_supported:['public'], id_token_signing_alg_values_supported:['RS256'],
      code_challenge_methods_supported:['S256'], ...scenario.metadata});
    if (url.pathname === '/jwks') return json({keys:[jwk]});
    if (url.pathname === '/authorize') {
      const code = randomUUID(); codes.set(code, {params:url.searchParams, scenario:{...scenario}});
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code',code); redirect.searchParams.set('state',url.searchParams.get('state'));
      res.writeHead(302,{location:redirect.href});return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      exchanges++;
      let body='';for await(const chunk of req) body+=chunk;
      const params = new URLSearchParams(body);
      const grant = codes.get(params.get('code')); codes.delete(params.get('code'));
      const authenticated = decodeURIComponent(Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString()) === 'aether:fixture-secret'
        || (params.get('client_id') === 'aether' && params.get('client_secret') === 'fixture-secret');
      if (!grant || !authenticated || params.get('redirect_uri') !== grant.params.get('redirect_uri')
          || createHash('sha256').update(params.get('code_verifier') || '').digest('base64url') !== grant.params.get('code_challenge')) {
        res.writeHead(400,{'content-type':'application/json'});return res.end(JSON.stringify({error:'invalid_grant'}));
      }
      const claims = {iss:origin, sub:'user-1', aud:'aether', iat:Math.floor(Date.now()/1000), exp:Math.floor(Date.now()/1000)+300,
        sid:'session-1', nonce:grant.params.get('nonce'), email:'admin@example.com', email_verified:true, ...grant.scenario.claims};
      const id_token = await new SignJWT(claims).setProtectedHeader({alg:'RS256', kid:'fixture'}).sign(grant.scenario.rogue ? rogue.privateKey : key.privateKey);
      return json({access_token:'fixture-access-token', token_type:'Bearer', expires_in:300, id_token});
    }
    res.writeHead(404);res.end();
  };
  const server = tls ? createHttpsServer(tls,handler) : createHttpServer(handler);
  server.listen(0,'127.0.0.1');await once(server,'listening');origin=`${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`;
  return {origin, signLogout:async (claims={}, rogueSignature=false)=>new SignJWT({iss:origin,aud:'aether',sub:'user-1',sid:'session-1',
      iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,jti:randomUUID(),
      events:{'http://schemas.openid.net/event/backchannel-logout':{}},...claims})
      .setProtectedHeader({alg:'RS256',kid:'fixture',typ:'logout+jwt'}).sign(rogueSignature ? rogue.privateKey:key.privateKey),
    setScenario:value=>{scenario=value;}, exchanges:()=>exchanges,
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
