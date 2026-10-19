import os, posixpath, paramiko
PWD = os.environ['DEPLOY_PWD']
ROOT = os.path.dirname(os.path.abspath(__file__))
REMOTE = '/opt/phone-repair-dispatch'
files = ['public/app.js', 'public/index.html', 'public/technician.js', 'public/technician.html', 'public/style.css']
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect('47.108.21.50', username='root', password=PWD, timeout=20)
sftp = c.open_sftp()
for rel in files:
    sftp.put(os.path.join(ROOT, rel.replace('/', os.sep)), posixpath.join(REMOTE, rel))
    print('UPLOAD', rel)
sftp.close()
_, o, _ = c.exec_command('systemctl restart phone-repair-dispatch.service && sleep 1 && systemctl is-active phone-repair-dispatch.service', timeout=30)
print(o.read().decode().strip())
c.close()
