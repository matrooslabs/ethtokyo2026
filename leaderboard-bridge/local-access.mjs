const hosts=new Set(['127.0.0.1','localhost','::1']);
export function localAccess(config){
 const requested=config.host||'127.0.0.1';
 if(!hosts.has(requested))throw Error('Unauthenticated bridge must bind to 127.0.0.1, localhost, or ::1; remote/shared hosting is unsupported');
 const host=requested==='localhost'?'127.0.0.1':requested;
 const port=config.port||8788;if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid bridge port');
 const origins=new Set(config.allowedOrigins||[]);
 for(const origin of origins){let u;try{u=new URL(origin);}catch{throw Error('Invalid allowed origin');}
  if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.origin!==origin)throw Error('Unauthenticated bridge only accepts explicitly configured loopback web origins');
 }
 const authorities=new Set(['127.0.0.1','localhost','[::1]'].map(h=>`${h}:${port}`));
 if(port===80)for(const h of ['127.0.0.1','localhost','[::1]'])authorities.add(h);
 return {host,port,check(req){
  // Literal Host allowlist blocks attacker-controlled domains resolving to loopback.
  if(!authorities.has(String(req.headers.host||'').toLowerCase()))return 'Host not allowed';
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return 'Loopback clients only';
  if(req.headers.origin&&!origins.has(req.headers.origin))return 'Origin not allowed';
  if(req.method==='POST'&&String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')return 'JSON content type required';
  return null;
 }};
}
