"""Read-only, bounded transcript resolver. Executed locally or over SSH stdin."""
import os, sys, json, hashlib, subprocess, time, stat, collections, re, base64
MAX_FILE = 128 * 1024 * 1024
MAX_LINE = 4 * 1024 * 1024
MAX_SCAN = 30000
class Problem(Exception):
    def __init__(self, code): self.code = code

def command(args):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, check=True).stdout.decode().strip()
def process(pid):
    try:
        if sys.platform.startswith('linux'):
            raw = open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()
            return {'pid':pid, 'start':raw[19], 'parent':int(raw[1]), 'cwd':os.path.realpath('/proc/%d/cwd' % pid),
                    'domain':'linux:'+open('/proc/sys/kernel/random/boot_id').read().strip().replace('-','')+':'+os.readlink('/proc/%d/ns/pid'%pid)}
        row = command(['ps','-p',str(pid),'-o','ppid=','-o','lstart=','-o','etime=']).split()
        elapsed = row[-1].split('-'); days = int(elapsed.pop(0)) if len(elapsed)>1 else 0
        values=list(map(int,elapsed[0].split(':'))); seconds=days*86400+sum(x*60**i for i,x in enumerate(reversed(values)))
        cwd=''
        for line in command(['lsof','-a','-p',str(pid),'-d','cwd','-Fn']).splitlines():
            if line.startswith('n'): cwd=os.path.realpath(line[1:])
        return {'pid':pid,'parent':int(row[0]),'start':' '.join(row[1:-1]),'cwd':cwd,'domain':'darwin','epoch':time.time()-seconds}
    except (OSError, ValueError, subprocess.SubprocessError): return None

def identity(p): return (p['pid'],p['start'],p['cwd'],p['domain']) if p else None

def descendants(root):
    ids=[root]; parents={}
    if sys.platform.startswith('linux'):
        names=os.listdir('/proc')
        for name in names:
            if not name.isdigit(): continue
            try:
                raw=open('/proc/'+name+'/stat').read().rsplit(')',1)[1].split()
                parents[int(name)]=int(raw[1])
            except (OSError,ValueError): pass
    else:
        for row in command(['ps','-axo','pid=,ppid=']).splitlines():
            vals=row.split()
            if len(vals)==2: parents[int(vals[0])]=int(vals[1])
    for _ in range(16):
        added=[pid for pid,parent in parents.items() if parent in ids and pid not in ids]
        ids+=added
        if len(ids)>128: raise Problem('ambiguous')
        if not added: return ids
    raise Problem('ambiguous')

def inside(path,root):
    return path.startswith(root+os.sep)
def files(root, session):
    count=0
    for base,dirs,names in os.walk(root,followlinks=False):
        dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(base,d))]
        count+=len(dirs)+len(names)
        if count>MAX_SCAN: raise Problem('limit')
        for name in names:
            if name==session+'.jsonl': yield os.path.realpath(os.path.join(base,name))

def descriptors(pid):
    try:
        if sys.platform.startswith('linux'):
            out=[]
            for fd in os.listdir('/proc/%d/fd'%pid):
                try: out.append(os.path.realpath('/proc/%d/fd/%s'%(pid,fd)))
                except OSError: pass
            return out
        return [l[1:] for l in command(['lsof','-a','-p',str(pid),'-Fn']).splitlines() if l.startswith('n')]
    except (OSError,subprocess.SubprocessError): return []

def header(path,fmt):
    with open(path,'rb') as f:
        for _ in range(100):
            line=f.readline(MAX_LINE+1)
            if len(line)>MAX_LINE: raise Problem('limit')
            if not line.endswith(b'\n'): break
            try: r=json.loads(line)
            except (ValueError,UnicodeError): raise Problem('invalid')
            if fmt=='responses' and r.get('type')=='session_meta':
                p=r.get('payload',{}); return p.get('id') or p.get('session_id'),p.get('cwd')
            if fmt=='messages' and r.get('sessionId') and r.get('cwd'): return r['sessionId'],r['cwd']
    return None,None

def resolve(req):
    rootproc=process(req['pid'])
    if not rootproc: raise Problem('not_found')
    if req.get('cwd') and os.path.realpath(req['cwd'])!=rootproc['cwd']: raise Problem('not_found')
    procs=[p for p in (process(pid) for pid in descendants(req['pid'])) if p]
    found={}
    for source in req['sources']:
        root=os.path.realpath(os.path.expanduser(source['root'])); fmt=source['format']
        if not os.path.isdir(root): continue
        for p in procs:
            paths=[path for path in descriptors(p['pid']) if path.endswith('.jsonl') and inside(os.path.realpath(path),root)]
            index=None
            if fmt=='messages' and source.get('sessions'):
                try:
                    indexpath=os.path.join(os.path.expanduser(source['sessions']),str(p['pid'])+'.json')
                    with open(indexpath,'rb') as f: index=json.loads(f.read(65537))
                    valid=index.get('pid')==p['pid'] and index.get('pidDomain')==p['domain'] and os.path.realpath(index.get('cwd',''))==p['cwd']
                    if sys.platform.startswith('linux'): valid=valid and str(index.get('procStart'))==p['start']
                    else: valid=valid and abs(float(index.get('startedAt',0))/1000-p['epoch'])<5
                    sid=index.get('sessionId')
                    if not valid or not isinstance(sid,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',sid): index=None
                    else: paths+=list(files(root,sid))
                except (OSError,ValueError,TypeError): index=None
            for path in set(paths):
                path=os.path.realpath(path)
                if not inside(path,root): continue
                sid,cwd=header(path,fmt)
                if not sid or not cwd or os.path.realpath(cwd)!=p['cwd']: continue
                if index and sid!=index['sessionId']: continue
                # A filename match alone is never authority: either descriptor or verified index.
                if path not in descriptors(p['pid']) and not index: continue
                found[(path,fmt,sid)]=(p,rootproc)
    if len(found)>1: raise Problem('ambiguous')
    if not found: raise Problem('not_found')
    (path,fmt,sid),(p,rootproc)=next(iter(found.items()))
    return path,fmt,sid,p,rootproc

def entries(r,fmt,offset):
    if fmt=='messages':
        if r.get('type') not in ('user','assistant') or any(r.get(k) for k in ('isMeta','isCompactSummary','isSidechain')): return []
        p=r.get('message',{}); role=p.get('role')
        if role!=r['type']: return []
        content=p.get('content',[]); key=r.get('uuid') or str(offset)
    else:
        if r.get('type')!='response_item': return []
        p=r.get('payload',{}); kind=p.get('type'); role=p.get('role')
        if kind in ('function_call','custom_tool_call'):
            return [('tool',tool(p.get('name')),p.get('call_id') or p.get('id') or str(offset))]
        if kind!='message' or p.get('phase') in ('analysis','summary') or p.get('channel') in ('analysis','summary'): return []
        if p.get('is_summary') or r.get('isCompactSummary'): return []
        content=p.get('content',[]); key=p.get('id') or str(offset)
    if role not in ('user','assistant'): return []
    if isinstance(content,str): content=[{'type':'text','text':content}]
    out=[]
    for i,b in enumerate(content):
        if not isinstance(b,dict): continue
        if b.get('type') in ('text','input_text','output_text') and isinstance(b.get('text'),str) and b['text']:
            out.append((role,b['text'],str(key)+':'+str(i)))
        elif role=='assistant' and b.get('type')=='tool_use': out.append(('tool',tool(b.get('name')),b.get('id') or str(key)+':'+str(i)))
    return out

def tool(name):
    return re.sub(r'[^\w .:/-]','',str(name or 'Tool').split('\n')[0])[:120] or 'Tool'

def read(req):
    path,fmt,sid,proc,rootproc=resolve(req)
    with open(path,'rb') as f:
        st=os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode): raise Problem('invalid')
        if st.st_size>MAX_FILE: raise Problem('limit')
        fingerprint=[st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns]
        binding=hashlib.sha256(json.dumps([identity(rootproc),identity(proc),path,fmt,sid,st.st_dev,st.st_ino]).encode()).hexdigest()
        expected=req.get('expected'); before=req.get('before')
        if expected and expected['binding']!=binding: raise Problem('changed')
        if req.get('cached')==fingerprint and not before:
            result={'unchanged':True,'binding':binding,'fingerprint':fingerprint}
        else:
            digest=hashlib.sha256(); prefix=hashlib.sha256(); seen=set(); turns=collections.deque(maxlen=51); current=None; offset=0; prefix_size=expected['size'] if expected else 0; page_bytes=0
            while offset<st.st_size:
                line=f.readline(min(MAX_LINE+1,st.st_size-offset))
                if len(line)>MAX_LINE: raise Problem('limit')
                if expected and offset<prefix_size: prefix.update(line[:prefix_size-offset])
                digest.update(line)
                if not line.endswith(b'\n'): offset+=len(line); break
                try: record=json.loads(line)
                except (ValueError,UnicodeError): raise Problem('invalid')
                selected=entries(record,fmt,offset)
                # A multipart user message starts one turn, not one turn per text block.
                fresh=[e for e in selected if e[2] not in seen]
                if fresh and fresh[0][0]=='user':
                    current={'id':str(offset),'entries':[],'offset':offset}
                    if before is None or offset<before: turns.append(current)
                for role,text,key in fresh:
                    seen.add(key)
                    if len(seen)>500000: raise Problem('limit')
                    if current is not None and (before is None or current['offset']<before):
                        current['entries'].append({'id':key,'role':role,'text':text})
                        if sum(len(e['text']) for e in current['entries'])>2*1024*1024 or len(current['entries'])>10000: raise Problem('limit')
                offset+=len(line)
            if expected and (st.st_size<prefix_size or prefix.hexdigest()!=expected['digest']): raise Problem('changed')
            more=len(turns)>50
            if more: turns.popleft()
            selected=list(turns)
            if sum(len(e['text'].encode()) for t in selected for e in t['entries'])>2*1024*1024: raise Problem('limit')
            result={'binding':binding,'fingerprint':fingerprint,'size':st.st_size,'digest':digest.hexdigest(),'turns':selected,'next':selected[0]['offset'] if more and selected else None}
        after=os.stat(path)
        if (after.st_dev,after.st_ino)!=(st.st_dev,st.st_ino) or after.st_size<st.st_size: raise Problem('changed')
        # A concurrent append is safe; any other concurrent mutation requires retry.
        if after.st_size==st.st_size and (after.st_mtime_ns,after.st_ctime_ns)!=(st.st_mtime_ns,st.st_ctime_ns): raise Problem('changed')
    if identity(process(proc['pid']))!=identity(proc) or identity(process(rootproc['pid']))!=identity(rootproc): raise Problem('changed')
    return result

try:
    request=json.loads(base64.b64decode(sys.argv[1]))
    print(json.dumps(read(request),separators=(',',':')))
except Problem as e: print(json.dumps({'error':e.code}))
except Exception: print(json.dumps({'error':'unavailable'}))
