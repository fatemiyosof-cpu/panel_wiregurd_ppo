const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }) : null;

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

async function initDb(){
  if(!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    panel_name TEXT NOT NULL DEFAULT '',
    profile TEXT NOT NULL DEFAULT '',
    volume TEXT NOT NULL DEFAULT '',
    days TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active',
    configs JSONB NOT NULL DEFAULT '[]'::jsonb
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS subscriptions_profile_idx ON subscriptions(profile)');
}

function makeId(){ return crypto.randomBytes(24).toString('base64url'); }
function baseUrl(req){ return BASE_URL || `${req.protocol}://${req.get('host')}`; }
function parseDays(v){
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function expirationFromDays(days){
  const n = parseDays(days);
  if(!n) return null;
  return new Date(Date.now() + n * 86400000).toISOString();
}
function normalizeConfigs(configs){
  if(!Array.isArray(configs)) return [];
  return configs.filter(c=>c && typeof c === 'object' && typeof c.content === 'string').map(c=>(
    { name:String(c.name||''), country:String(c.country||''), countryCode:String(c.countryCode||''), data:c.data ?? null, days:String(c.days ?? ''), content:c.content }
  ));
}

async function getSub(id){
  if(!pool) throw new Error('DATABASE_URL is required');
  const r=await pool.query('SELECT * FROM subscriptions WHERE id=$1',[id]);
  return r.rows[0] || null;
}
function publicSub(row, req){
  return {ok:true,id:row.id,subscriptionId:row.id,url:`${baseUrl(req)}/sub/${encodeURIComponent(row.id)}`,panelName:row.panel_name,profile:row.profile,volume:row.volume,days:row.days,createdAt:row.created_at,expiresAt:row.expires_at,status:row.status,configs:row.configs||[]};
}

app.get('/health',(req,res)=>res.json({ok:true,service:'arcodm-panel-subscription'}));

app.post('/api/subscriptions', async (req,res)=>{
  try{
    const b=req.body||{};
    const configs=normalizeConfigs(b.configs);
    if(!configs.length) return res.status(400).json({ok:false,error:'configs must contain at least one valid config'});
    let id=String(b.subscriptionId||'').trim();
    let existing=id ? await getSub(id) : null;
    if(!existing){ id=makeId(); }
    const profile=String(b.profile||b.panelName||'').trim();
    const panelName=String(b.panelName||profile).trim();
    const volume=String(b.volume||'').trim();
    const days=String(b.days ?? configs[0]?.days ?? '').trim();
    const expiresAt=expirationFromDays(days);
    if(existing){
      await pool.query(`UPDATE subscriptions SET panel_name=$1,profile=$2,volume=$3,days=$4,expires_at=$5,status='active',configs=$6,created_at=COALESCE(created_at,NOW()) WHERE id=$7`,[panelName,profile,volume,days,expiresAt,JSON.stringify(configs),id]);
    } else {
      await pool.query(`INSERT INTO subscriptions(id,panel_name,profile,volume,days,expires_at,status,configs) VALUES($1,$2,$3,$4,$5,$6,'active',$7)`,[id,panelName,profile,volume,days,expiresAt,JSON.stringify(configs)]);
    }
    const row=await getSub(id);
    res.json(publicSub(row,req));
  }catch(e){ console.error(e); res.status(500).json({ok:false,error:'subscription storage failed'}); }
});

app.get('/api/subscriptions/:id', async (req,res)=>{
  try{
    const row=await getSub(req.params.id);
    if(!row) return res.status(404).json({ok:false,error:'subscription not found'});
    if(row.expires_at && new Date(row.expires_at)<=new Date()) return res.json({...publicSub(row,req),status:'expired',configs:[]});
    res.json(publicSub(row,req));
  }catch(e){ console.error(e); res.status(500).json({ok:false,error:'subscription lookup failed'}); }
});

app.delete('/api/subscriptions/:id', async (req,res)=>{
  try{
    const r=await pool.query(`UPDATE subscriptions SET status='disabled',configs='[]'::jsonb WHERE id=$1 RETURNING id`,[req.params.id]);
    if(!r.rowCount) return res.status(404).json({ok:false,error:'subscription not found'});
    res.json({ok:true,id:req.params.id,status:'disabled'});
  }catch(e){ console.error(e); res.status(500).json({ok:false,error:'subscription delete failed'}); }
});

app.get('/sub/:id', async (req,res)=>{
  try{
    const row=await getSub(req.params.id);
    if(!row) return res.status(404).type('text/plain').send('Subscription not found');
    if(row.status!=='active' || (row.expires_at && new Date(row.expires_at)<=new Date())) return res.status(410).type('text/plain').send('Subscription expired or disabled');
    const configs=Array.isArray(row.configs)?row.configs:[];
    if(req.query.format==='json') return res.json({ok:true,id:row.id,profile:row.profile,expiresAt:row.expires_at,configs});
    const text=configs.map(c=>c.content).filter(Boolean).join('\n\n');
    res.type('text/plain; charset=utf-8').send(text || 'No active configs');
  }catch(e){ console.error(e); res.status(500).type('text/plain').send('Subscription error'); }
});

const publicDir=path.join(__dirname,'public');
app.use(express.static(publicDir,{index:'AR.html'}));
app.get('/',(req,res)=>res.sendFile(path.join(publicDir,'AR.html')));
app.use((req,res)=>res.status(404).json({ok:false,error:'not found'}));

initDb().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`ARcodm panel listening on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
