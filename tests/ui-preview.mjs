import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';

const root = join(process.cwd(), 'dist');
const user = { id:'preview-user', username:'preview', displayName:'Izzy', canModerate:false, canAdmin:false, color:'#356955', status:'online', settings:{} };
const fake = path => {
  if (path === '/health') return { ok:true, version:'13.0.0', aiModels:['axiom-ai','work','code','sol','terra'].map(id=>({id})) };
  if (path === '/me') return {user};
  if (path.includes('projects')) return {projects:[]};
  if (path.includes('online')) return {users:[],members:[],count:0};
  if (path.includes('notification')) return {notifications:[],unread:0};
  if (path.includes('groups')) return {groups:[],invites:[],unread:0};
  if (path.includes('dms')) return {conversations:[],unread:0};
  return {};
};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(fake(url.pathname.slice(4))));return;
  }
  const file=join(root,normalize(url.pathname.replace(/^\//,'')||'index.html'));
  if(!file.startsWith(root)){res.writeHead(403).end();return;}
  try{
    const body=await readFile(file);
    const type={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'}[extname(file)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':type});res.end(body);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:'chrome'});
await mkdir('.preview',{recursive:true});
try{
  for(const [name,width,height] of [['desktop',1440,900],['laptop',1024,768],['mobile',390,844]]){
    const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,colorScheme:'dark'});
    await context.addInitScript(()=>sessionStorage.setItem('axiom_session_v3','preview-token'));
    await context.route('**/axiom-proxy.itsizzydudee.workers.dev/**',route=>{
      const path=new URL(route.request().url()).pathname;
      return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(fake(path))});
    });
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base,{waitUntil:'domcontentloaded'});
    await page.waitForTimeout(1100);
    const state=await page.evaluate(()=>({appVisible:!document.getElementById('app').hidden,sidebarWidth:document.querySelector('.sidebar').getBoundingClientRect().width,composer:document.getElementById('chatForm').getBoundingClientRect().toJSON(),title:document.getElementById('topTitle').textContent,overflow:document.documentElement.scrollWidth>innerWidth}));
    await page.screenshot({path:`.preview/${name}.png`,fullPage:false});
    console.log(name,JSON.stringify({state,errors}));
    await context.close();
  }
}finally{await browser.close();server.close();}
