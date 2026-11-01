"""Private generated-name upload storage; receives only server-built requests."""
import os,sys,json,base64,stat,hashlib,signal,re
signal.alarm(25)
request=json.loads(base64.b64decode(sys.argv[1]))
handles=[]
try:
    root=os.path.expanduser(request['root'])
    if not os.path.isabs(root) or '..' in root.split(os.sep): raise ValueError()
    date=request['date'];name=request['filename']
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date) or not re.fullmatch(r'[a-f0-9]{48}\.(png|jpg|gif|webp|pdf|txt)',name): raise ValueError()
    parts=root.split(os.sep)
    fd=os.open(os.sep,os.O_RDONLY|os.O_DIRECTORY);handles.append(fd)
    for component in [p for p in parts if p]+[date]:
        try: os.mkdir(component,0o700,dir_fd=fd)
        except FileExistsError: pass
        child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);handles.append(child);fd=child
        if component==date or len(handles)==len([p for p in parts if p])+1: os.fchmod(fd,0o700)
    partial='.part-'+name
    action=request['action']
    if action=='write':
        output=os.open(partial,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
        os.fchmod(output,0o600)
        handles.append(output);total=0;digest=hashlib.sha256()
        try:
            while True:
                data=sys.stdin.buffer.read(65536)
                if not data: break
                total+=len(data)
                if total>request['size'] or total>20*1024*1024: raise ValueError()
                digest.update(data)
                view=memoryview(data)
                while view: view=view[os.write(output,view):]
            if total!=request['size'] or digest.hexdigest()!=request['digest']: raise ValueError()
            os.fsync(output)
            os.link(partial,name,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
            os.unlink(partial,dir_fd=fd);os.fsync(fd)
        except BaseException:
            try: os.unlink(partial,dir_fd=fd)
            except OSError: pass
            raise
        print(json.dumps({'path':os.path.join(root,date,name)}))
    elif action=='remove':
        for item in [partial,name]:
            try:
                s=os.stat(item,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISREG(s.st_mode): os.unlink(item,dir_fd=fd)
                else: raise ValueError()
            except FileNotFoundError: pass
        print('{}')
    elif action=='check':
        f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd);handles.append(f)
        s=os.fstat(f)
        if not stat.S_ISREG(s.st_mode) or s.st_size!=request['size'] or stat.S_IMODE(s.st_mode)!=0o600: raise ValueError()
        digest=hashlib.sha256()
        while True:
            data=os.read(f,65536)
            if not data: break
            digest.update(data)
        if digest.hexdigest()!=request['digest']: raise ValueError()
        print(json.dumps({'path':os.path.join(root,date,name)}))
    else: raise ValueError()
except Exception:
    print(json.dumps({'error':'storage_unavailable'}))
finally:
    for fd in reversed(handles):
        try:os.close(fd)
        except OSError:pass
