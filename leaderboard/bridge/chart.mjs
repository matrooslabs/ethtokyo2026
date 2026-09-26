import {createHash} from 'node:crypto';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function canonicalChartHash(chart){
 const prefix=Buffer.alloc(7);prefix.writeUInt16BE(1,0);prefix[2]=chart.key_count;prefix.writeUInt32BE(chart.notes.length,3);
 const notes=chart.notes.map(n=>{const b=Buffer.alloc(17);b[0]=n.lane;b.writeBigUInt64BE(BigInt(n.start_us),1);b.writeBigUInt64BE(BigInt(n.end_us),9);return b;});
 return '0x'+sha(Buffer.concat([Buffer.from('OSUMANIA_CHART_V1'),prefix,...notes]));
}
export function parseOsu(bytes){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');let section='';const props={};const notes=[];
 for(const raw of text.split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('//'))continue;if(/^\[.*\]$/.test(line)){section=line.slice(1,-1);continue;}
 if(section==='HitObjects'){const p=line.split(',');const x=Number(p[0]),ms=Number(p[2]),type=Number(p[3]);if(!Number.isInteger(x)||x<0||x>512||!Number.isInteger(ms)||ms<0||!Number.isInteger(type)||(!(type&1)&&!(type&128)))throw Error('Unsupported hit object');const end=(type&128)?Number(p[5]?.split(':')[0]):ms;if(!Number.isInteger(end)||end<ms)throw Error('Invalid hold');notes.push({lane:Math.min(3,Math.floor(x*4/512)),start_us:ms*1000,end_us:end*1000});}
 else {const k=line.indexOf(':');if(k>=0)props[section+'.'+line.slice(0,k).trim()]=line.slice(k+1).trim();}}
 if(props['General.Mode']!=='3'||Number(props['Difficulty.CircleSize'])!==4)throw Error('Only 4-key mania charts supported');
 if(!notes.length||notes.length>10000)throw Error('Chart note count out of range');
 notes.sort((a,b)=>a.start_us-b.start_us||a.lane-b.lane||a.end_us-b.end_us);
 const ends=[-1,-1,-1,-1];for(const n of notes){if(n.start_us<=ends[n.lane])throw Error('Overlapping or duplicate notes');ends[n.lane]=n.end_us;}
 const maxEnd=Math.max(...notes.map(n=>n.end_us));if(maxEnd+136500>1800000000)throw Error('Chart exceeds maximum duration');
 return {webBeatmapHash:sha(bytes),chart:{key_count:4,notes},firstNoteMs:notes[0].start_us/1000,maxEnd,title:props['Metadata.Title']||'Untitled',difficulty:props['Metadata.Version']||''};
}
export function replayEvents(body,chart){
 const {replay,timing}=body;if(replay?.version!==2||!Array.isArray(replay.inputs)||replay.inputs.length>50000)throw Error('Unsupported replay');
 const mods=replay.mods;if(!mods||mods.bits!==0||mods.rate!==1||['hpOverride','odOverride','accuracyChallenge','cover','percy'].some(k=>mods[k]!=null))throw Error('Scoring mods unsupported');
 const delay=Math.max(1000-chart.firstNoteMs,0);if(timing?.chartDelayMs!==delay)throw Error('Chart timing mismatch');
 let last=-1;const keys=[false,false,false,false];
 return replay.inputs.map((event,sequence)=>{if(!Array.isArray(event)||event.length!==3)throw Error('Invalid replay event');const [lane,time,down]=event;const us=Math.round((time-delay)*1000);
 if(!Number.isInteger(lane)||lane<0||lane>3||!Number.isFinite(time)||typeof down!=='boolean'||!Number.isSafeInteger(us)||us<0||us<last||us>1800000000||keys[lane]===down)throw Error('Invalid replay key transition or timestamp');last=us;keys[lane]=down;return {sequence,timestamp_us:us,lane,action:down?0:1};});
}
