"""Read-only, bounded transcript resolver. Executed locally or over SSH stdin."""
import os, sys, json, hashlib, subprocess, time, stat, collections, re, base64, signal
MAX_WINDOW = 8 * 1024 * 1024
MAX_OUTPUT = 2 * 1024 * 1024
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
                    'domain':'linux:'+open('/etc/machine-id').read().strip()+':'+os.readlink('/proc/%d/ns/pid'%pid)}
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
        if count>MAX_SCAN: raise Problem('discovery')
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
        budget=MAX_WINDOW; dropping=False
        while budget:
            line=f.readline(min(MAX_LINE+1,budget)); budget-=len(line)
            if not line: break
            if dropping or len(line)>MAX_LINE:
                dropping=not line.endswith(b'\n')
                continue
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

def guard(f, size, boundary):
    # Small fixed guards detect edits at both snapshot ends and the paging seam.
    spans=[]
    for point in (0, size, boundary):
        start=max(0,point-4096); end=min(size,point+4096)
        f.seek(start); spans.append([start,end,hashlib.sha256(f.read(end-start)).hexdigest()])
    return spans

def read(req):
    path,fmt,sid,proc,rootproc=resolve(req)
    with open(path,'rb') as f:
        st=os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode): raise Problem('invalid')
        fingerprint=list(map(str,[st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns]))
        binding=hashlib.sha256(json.dumps([identity(rootproc),identity(proc),path,fmt,sid,st.st_dev,st.st_ino,req.get('terminal')]).encode()).hexdigest()
        expected=req.get('expected'); before=req.get('before')
        if expected:
            if expected['binding']!=binding or st.st_size<expected['size']: raise Problem('changed')
            if st.st_size==int(expected['fingerprint'][2]) and fingerprint!=expected['fingerprint']: raise Problem('changed')
            for start,end,digest in expected['guards']:
                f.seek(start)
                if hashlib.sha256(f.read(end-start)).hexdigest()!=digest: raise Problem('changed')
        if req.get('cached')==fingerprint and before is None:
            result={'unchanged':True,'binding':binding,'fingerprint':fingerprint}
        else:
            size=expected['size'] if before is not None else st.st_size
            end=before if before is not None else size
            start=max(0,end-MAX_WINDOW)
            f.seek(start); data=f.read(end-start)
            warnings=set(); records=[]
            # A scan seam can bisect a record. Consume that prefix on the older
            # page, where its complete record can be read, rather than dropping it.
            head=0
            if start:
                f.seek(start-1)
                if f.read(1)!=b'\n':
                    newline=data.find(b'\n')
                    head=len(data) if newline<0 else newline+1
                    if head>MAX_LINE: warnings.add('long_output_trimmed')
            complete=data.rfind(b'\n')+1
            if before is not None and complete<len(data):
                # The cursor bisects a record larger than the entire scan budget.
                warnings.add('long_output_trimmed')
            pos=head
            while pos<complete:
                stop=data.find(b'\n',pos)+1
                if stop-pos>MAX_LINE: warnings.add('long_output_trimmed')
                else:
                    try: record=json.loads(data[pos:stop])
                    except (ValueError,UnicodeError): raise Problem('invalid')
                    records.append((start+pos,entries(record,fmt,start+pos)))
                pos=stop
            # Reverse selection includes the newest snapshot for a repeated ID.
            groups=[]; current=[]; seen=set(); used=0; boundary=end; closed=0
            for offset,selected in reversed(records):
                fresh=[e for e in selected if e[2] not in seen]
                cost=sum(min(len(e[1].encode()),MAX_OUTPUT-64) for e in fresh)
                if used and used+cost>MAX_OUTPUT: break
                if closed>=50: break
                kept=[]
                for index,(role,text,key) in enumerate(fresh):
                    raw=text.encode(); remaining=(MAX_OUTPUT-used)//(len(fresh)-index)
                    if len(raw)>remaining or len(raw)>MAX_OUTPUT-64:
                        limit=max(0,min(remaining-32,MAX_OUTPUT-64))
                        text=(raw[:limit].decode('utf-8','ignore')+'\n[long output trimmed]') if remaining>=32 else ''
                        warnings.add('long_output_trimmed')
                    if len(text.encode())>remaining: break
                    used+=len(text.encode()); seen.add(key)
                    kept.append({'id':key,'role':role,'text':text})
                if kept: current=kept+current
                boundary=offset
                if fresh and fresh[0][0]=='user' and current:
                    groups.append({'id':str(offset),'entries':current})
                    current=[]; closed+=1
            else:
                boundary=start+head if head<len(data) else start
                if start and head:
                    # Re-read a partial head on the next page when it fits. If no
                    # newline exists in this window, advance past the giant record.
                    boundary=start+head if head<len(data) else start
            if current:
                groups.append({'id':'fragment:'+str(end),'entries':current,'continuesPrevious':boundary>0})
            groups.reverse()
            if req.get('join') and groups: groups[-1]['id']=req['join']
            next_join=(groups[0]['id'] if groups[0].get('continuesPrevious') else None) if groups else req.get('join')
            if boundary>0 and (start>0 or used>=MAX_OUTPUT or closed>=50): warnings.add('scan_limited')
            guards=guard(f,size,boundary)
            result={'binding':binding,'fingerprint':fingerprint,'size':size,'guards':guards,
                    'digest':hashlib.sha256(json.dumps([fingerprint,guards]).encode()).hexdigest(),
                    'scanned':len(data),'outputBytes':used,'turns':groups,'next':boundary if boundary>0 else None,'join':next_join,'warnings':sorted(warnings)}
        after=os.stat(path)
        if (after.st_dev,after.st_ino)!=(st.st_dev,st.st_ino) or after.st_size<st.st_size: raise Problem('changed')
        if after.st_size==st.st_size and (after.st_mtime_ns,after.st_ctime_ns)!=(st.st_mtime_ns,st.st_ctime_ns): raise Problem('changed')
    if identity(process(proc['pid']))!=identity(proc) or identity(process(rootproc['pid']))!=identity(rootproc): raise Problem('changed')
    again=resolve(req)
    if (again[0],again[1],again[2],identity(again[3]),identity(again[4]))!=(path,fmt,sid,identity(proc),identity(rootproc)): raise Problem('changed')
    return result

try:
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(Problem("timeout")))
    signal.alarm(10)
    request=json.loads(base64.b64decode(sys.argv[1]))
    print(json.dumps(read(request),separators=(',',':')))
except Problem as e: print(json.dumps({'error':e.code}))
except Exception: print(json.dumps({'error':'unavailable'}))
