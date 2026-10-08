import {DurableObject, WorkerEntrypoint} from 'cloudflare:workers';

const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))))
  .map(v=>v.toString(16).padStart(2,'0')).join('');
export class SessionRegistry extends WorkerEntrypoint {
  #registry() {return this.ctx.exports.OidcSessions.getByName('sessions');}
  async register(email, secret, identity) {return this.#registry().register(await hash(`${email}:${secret}`),email,identity);}
  async authenticate(token) {const id=await hash(token);await this.#registry().check(id);return id;}
  async principal(token) {return this.#registry().check(await hash(token));}
  async accessVersion() {return this.env.DEPARTMENTS_ENABLED === 'true' ? this.env.DEPARTMENTS.accessVersion() : null;}
  async check(id, accessVersion) {
    const email=await this.#registry().check(id);
    if(this.env.DEPARTMENTS_ENABLED === 'true' && (!Number.isSafeInteger(accessVersion) || accessVersion !== await this.env.DEPARTMENTS.accessVersion()))
      throw new Error('Department access changed; reconnect required');
    return email;
  }
  watch(id, watcher) {return this.#registry().watch(id,watcher);}
  unwatch(id, watcher) {return this.#registry().unwatch(id,watcher);}
}

/** Durable revocation state; transient waiters actively close authenticated WebSockets. */
export class OidcSessions extends DurableObject {
  #waiters = new Map();
  constructor(ctx, env) {
    super(ctx,env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      sid TEXT, issued INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS sessions_identity ON sessions(issuer,subject,sid);
      CREATE INDEX IF NOT EXISTS sessions_sid ON sessions(issuer,sid,subject);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
      CREATE TABLE IF NOT EXISTS logout_events (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS logout_cutoffs (id TEXT PRIMARY KEY, issued INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  }
  #sql(query,...args) {return this.ctx.storage.sql.exec(query,...args);}
  #prune() {
    const expired=new Set(this.#sql('SELECT id FROM sessions WHERE expires<=?',Date.now()).toArray().map(row=>row.id));
    this.#notify(expired,'expired');
    this.#sql('DELETE FROM sessions WHERE expires <= ?',Date.now());
    this.#sql('DELETE FROM logout_events WHERE expires <= ?',Date.now());
    this.#sql('DELETE FROM logout_cutoffs WHERE expires <= ?',Date.now());
  }
  #alarm() {
    const next=this.#sql('SELECT MIN(expires) AS expires FROM sessions WHERE revoked=0').one().expires;
    if(next !== null) this.ctx.storage.setAlarm(Math.max(Date.now()+1,next));
    else this.ctx.storage.deleteAlarm();
  }
  async register(id,email,identity) {
    const ttl=Number(this.env.SESSION_TTL);
    if(!Number.isInteger(ttl) || ttl<60 || ttl>86400 || !identity || typeof identity.issuer !== 'string'
        || typeof identity.subject !== 'string' || !Number.isInteger(identity.issuedAt)) throw new Error('Invalid OIDC session');
    const subjectKey=await hash(JSON.stringify([identity.issuer,'sub',identity.subject]));
    const sidKey=identity.sid ? await hash(JSON.stringify([identity.issuer,'sid',identity.sid])) : null;
    const sidSubjectKey=identity.sid ? await hash(JSON.stringify([identity.issuer,'sid-sub',identity.sid,identity.subject])) : null;
    if(this.env.DEPARTMENTS_ENABLED === "true") await this.env.DEPARTMENTS.syncLogin(email,identity.departments || []);
    this.#prune();
    const cutoff=this.#sql('SELECT issued FROM logout_cutoffs WHERE id=?',subjectKey).toArray()[0];
    if((cutoff && identity.issuedAt<=cutoff.issued) || (sidKey && this.#sql('SELECT id FROM logout_cutoffs WHERE id IN (?,?)',sidKey,sidSubjectKey).toArray().length))
      throw new Error('IdP session was logged out');
    if(this.#sql('SELECT COUNT(*) AS count FROM sessions').one().count>=100000) throw new Error('Session capacity exhausted');
    this.#sql('INSERT INTO sessions(id,email,issuer,subject,sid,issued,expires) VALUES(?,?,?,?,?,?,?)',
      id,email,identity.issuer,identity.subject,identity.sid ?? null,identity.issuedAt,Date.now()+ttl*1000);
    this.#alarm();
  }
  check(id) {
    const session=this.#sql('SELECT email,revoked,expires FROM sessions WHERE id=?',id).toArray()[0];
    if(!session || session.revoked || session.expires<=Date.now()) throw new Error('OIDC session revoked or expired');
    return session.email;
  }
  async watch(id,watcher) {
    this.check(id);
    if(this.#waiters.size>=2048 || this.#waiters.has(watcher)) throw new Error('Session watcher capacity exhausted');
    let timer;
    try {return await new Promise(resolve=>{this.#waiters.set(watcher,{id,resolve});timer=setTimeout(()=>resolve('renew'),60000);});}
    finally {clearTimeout(timer);this.#waiters.delete(watcher);}
  }
  unwatch(id,watcher) {const wait=this.#waiters.get(watcher);if(wait?.id===id)wait.resolve('disconnected');}
  #notify(ids, reason) {
    for(const wait of this.#waiters.values()) if(ids.has(wait.id))wait.resolve(reason);
  }
  async revoke(logout) {
    const eventId=await hash(JSON.stringify([logout.issuer,logout.jti]));
    const cutoffId=await hash(JSON.stringify(logout.sid && logout.subject ? [logout.issuer,'sid-sub',logout.sid,logout.subject]
      : [logout.issuer,logout.sid ? 'sid':'sub',logout.sid || logout.subject]));
    this.#prune();
    if(this.#sql('SELECT id FROM logout_events WHERE id=?',eventId).toArray().length)return;
    // All writes and waiter notifications are synchronous after hashing, so login cannot interleave.
    this.#sql('INSERT INTO logout_events(id,expires) VALUES(?,?)',eventId,Date.now()+310000);
    this.#sql(`INSERT INTO logout_cutoffs(id,issued,expires) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET
      issued=MAX(issued,excluded.issued),expires=MAX(expires,excluded.expires)`,cutoffId,logout.issuedAt,Date.now()+86710000);
    let where='issuer=?', args=[logout.issuer];
    if(logout.sid) {where+=' AND sid=?';args.push(logout.sid);}
    if(logout.subject) {where+=' AND subject=?';args.push(logout.subject);}
    const ids=new Set(this.#sql(`SELECT id FROM sessions WHERE ${where}`,...args).toArray().map(row=>row.id));
    this.#sql(`UPDATE sessions SET revoked=1 WHERE ${where}`,...args);
    this.#notify(ids,'revoked');this.#alarm();
  }
  alarm() {
    const ids=new Set(this.#sql('SELECT id FROM sessions WHERE expires<=?',Date.now()).toArray().map(row=>row.id));
    this.#notify(ids,'expired');this.#prune();this.#alarm();
  }
}
