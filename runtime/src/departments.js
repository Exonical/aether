import {DurableObject, WorkerEntrypoint} from 'cloudflare:workers';

const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s:@]+@[^\s:@]+$/.test(value);
const fail = () => {throw new Error('Department operation denied');};

/** Private directory capability, bound only to the trusted backend and OIDC registry. */
export class DepartmentDirectory extends WorkerEntrypoint {
  syncLogin(email, departmentIds) {return this.ctx.exports.Departments.getByName('directory').syncLogin(email, departmentIds);}
  accessVersion() {return this.ctx.exports.Departments.getByName('directory').accessVersion();}
  assertShare(owner, recipient) {return this.ctx.exports.Departments.getByName('directory').assertShare(owner, recipient);}
}

/** Membership authority. Global admins manage departments; scoped admins manage their members. */
export class Departments extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS departments(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(department TEXT NOT NULL, email TEXT NOT NULL,
        source TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(department,email,source));
      CREATE INDEX IF NOT EXISTS member_email ON members(email);
      CREATE TABLE IF NOT EXISTS access_version(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO access_version VALUES(1,0);
      CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL,
        action TEXT NOT NULL, department TEXT, target TEXT, at INTEGER NOT NULL);`);
  }
  #sql(query, ...args) {return this.ctx.storage.sql.exec(query, ...args);}
  #global(actor) {
    const admins = JSON.parse(this.env.ADMINS);
    return Array.isArray(admins) && admins.includes(actor);
  }
  #admin(actor, department) {
    return this.#global(actor) || this.#sql('SELECT email FROM members WHERE email=? AND department=? AND role=?',actor,department,'admin').toArray().length > 0;
  }
  #audit(actor, action, department=null, target=null) {
    this.#sql('INSERT INTO audit(actor,action,department,target,at) VALUES(?,?,?,?,?)',actor,action,department,target,Date.now());
    // Bounded local administrative history. Export before pruning if longer retention is needed.
    this.#sql('DELETE FROM audit WHERE sequence <= (SELECT MAX(sequence)-10000 FROM audit)');
  }
  syncLogin(email, departmentIds) {
    if(!validEmail(email) || !Array.isArray(departmentIds) || departmentIds.length>64 || departmentIds.some(id=>!validId(id))) fail();
    const ids=[...new Set(departmentIds)];
    if(ids.some(id=>!this.#sql('SELECT id FROM departments WHERE id=?',id).toArray().length)) fail();
    this.ctx.storage.transactionSync(()=>{
      const old=this.#sql('SELECT department FROM members WHERE email=? AND source=? ORDER BY department',email,'oidc').toArray().map(row=>row.department);
      const count=this.#sql('SELECT COUNT(*) AS count FROM members').one().count;
      if(count-old.length+ids.length>100000)fail();
      this.#sql('DELETE FROM members WHERE email=? AND source=?',email,'oidc');
      for(const id of ids)this.#sql('INSERT INTO members VALUES(?,?,?,?)',id,email,'oidc','member');
      if(JSON.stringify(old)!==JSON.stringify([...ids].sort())){this.#sql('UPDATE access_version SET value=value+1 WHERE id=1');this.#audit(email,'oidc-sync',null,JSON.stringify(ids));}
    });
  }
  accessVersion() {return this.#sql('SELECT value FROM access_version WHERE id=1').one().value;}
  assertShare(owner, recipient) {
    if(!validEmail(owner) || !validEmail(recipient))fail();
    // Owner and recipient must share a current department; no administrative bypass.
    if(!this.#sql(`SELECT a.department FROM members a JOIN members b ON a.department=b.department
      WHERE a.email=? AND b.email=? LIMIT 1`,owner,recipient).toArray().length)fail();
  }
  read(actor) {
    const globalAdmin=this.#global(actor);
    const departments=globalAdmin ? this.#sql('SELECT id,name FROM departments ORDER BY name').toArray()
      : this.#sql('SELECT DISTINCT d.id,d.name FROM departments d JOIN members m ON d.id=m.department WHERE m.email=? ORDER BY d.name',actor).toArray();
    return {email:actor, globalAdmin, departments:departments.map(department=>({...department,
      canManage:this.#admin(actor,department.id),
      members:this.#admin(actor,department.id) ? this.#sql('SELECT email,source,role FROM members WHERE department=? ORDER BY email,source',department.id).toArray() : undefined}))};
  }
  mutate(actor, body) {
    if(!body || !validId(body.department))fail();
    const {action,department,email,role,name}=body;
    // Authorization and mutation run synchronously; no stale capability caches.
    if(action==='create' || action==='rename' || action==='delete') {
      if(!this.#global(actor))fail();
      if(action!=='delete' && (typeof name!=='string' || !name.trim() || name.length>100 || /[\x00-\x1f\x7f]/.test(name)))fail();
      if(action==='create' && this.#sql('SELECT COUNT(*) AS count FROM departments').one().count>=256)fail();
    } else if(action==='setMember' || action==='removeMember') {
      if(!validEmail(email) || !this.#admin(actor,department))fail();
      if(action==='setMember' && !['member','admin'].includes(role))fail();
      // Only deployment admins appoint/demote scoped admins. IdP groups cannot grant admin.
      if(!this.#global(actor) && (role==='admin' || this.#sql('SELECT email FROM members WHERE department=? AND email=? AND role=?',department,email,'admin').toArray().length))fail();
    } else fail();
    if(action!=='create' && !this.#sql('SELECT id FROM departments WHERE id=?',department).toArray().length)fail();
    this.ctx.storage.transactionSync(()=>{
      if(action==='create')this.#sql('INSERT INTO departments VALUES(?,?)',department,name.trim());
      if(action==='rename')this.#sql('UPDATE departments SET name=? WHERE id=?',name.trim(),department);
      if(action==='delete'){
        this.#sql('DELETE FROM members WHERE department=?',department);
        this.#sql('DELETE FROM departments WHERE id=?',department);
      }
      if(action==='setMember'){
        if(this.#sql('SELECT COUNT(*) AS count FROM members').one().count>=100000)fail();
        this.#sql('INSERT INTO members VALUES(?,?,?,?) ON CONFLICT(department,email,source) DO UPDATE SET role=excluded.role',department,email,'manual',role);
      }
      if(action==='removeMember')this.#sql('DELETE FROM members WHERE department=? AND email=? AND source=?',department,email,'manual');
      if(action!=='rename')this.#sql('UPDATE access_version SET value=value+1 WHERE id=1');
      this.#audit(actor,action,department,email || null);
    });
    return this.read(actor);
  }
  audit(actor) {
    if(!this.#global(actor))fail();
    return this.#sql('SELECT actor,action,department,target,at FROM audit ORDER BY sequence DESC LIMIT 200').toArray();
  }
}

export default {
  async fetch(request, env, ctx) {
    const reply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
    if(env.ENABLED!=='true')return new Response('Not found',{status:404});
    const path=new URL(request.url).pathname;
    if(path==='/departments' && request.method==='GET')return new Response(env.UI,{headers:{
      'content-type':'text/html; charset=utf-8','cache-control':'no-store',
      'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"}});
    if(path!=='/api/departments' || !['GET','POST'].includes(request.method))return reply({error:'Not found'},404);
    // Aether's entry Worker checks browser cookie and Origin before routing this path.
    const token=request.headers.get('authorization');
    if(!token?.startsWith('Bearer ') || token.length>4096)return reply({error:'Sign-in required'},401);
    let actor;
    try {actor=await env.SESSIONS.principal(token.slice(7));}catch{return reply({error:'Sign-in required'},401);}
    const directory=ctx.exports.Departments.getByName('directory');
    try {
      if(request.method==='GET')return reply(await directory.read(actor));
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))return reply({error:'JSON required'},415);
      let size=0, text='';const decoder=new TextDecoder();const reader=request.body?.getReader();
      if(!reader)return reply({error:'JSON required'},400);
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();return reply({error:'Request too large'},413);}text+=decoder.decode(value,{stream:true});}
      text+=decoder.decode();
      const body=JSON.parse(text);
      return reply(body.action==='audit' ? await directory.audit(actor) : await directory.mutate(actor,body));
    }catch{return reply({error:'Department operation denied'},403);}
  },
};
