"""Fake SSH/SFTP server for local end-to-end tests of the dsh-deploy helper.

Runs on 127.0.0.1:2222, accepts any credentials, serves SFTP over a virtual root
(absolute remote paths map under <root>), and emulates the POSIX commands the
deploy helper emits (mkdir/cp/mv/rm/tar/unzip/echo/curl-probe) against that root.

Usage: python fake_ssh_server.py <virtual-root-dir>
"""
import os
import re
import shutil
import socket
import sys
import tarfile
import threading
import time
import zipfile

import paramiko

HOST = '127.0.0.1'
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 2222
ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.abspath('virtual-root')
HOST_KEY = paramiko.RSAKey.generate(2048)


def tr(path):
    """Translate a remote POSIX path into the virtual root."""
    p = os.path.normpath(path).replace('\\', '/').lstrip('/')
    parts = [seg for seg in p.split('/') if seg and seg != '..']
    return os.path.join(ROOT, *parts)


def q(s):
    return '"' + s + '"'


def run_command(cmd):
    """Emulate the remote POSIX commands the helper emits. Returns (exit, stdout, stderr)."""
    cmd = cmd.strip()
    if 'http_code' in cmd:  # health-check probe (curl/wget)
        return 0, '200', ''
    try:
        if ' && ' in cmd:
            out_parts = []
            for part in cmd.split(' && '):
                code, out, err = run_command(part.strip())
                if code != 0:
                    return code, out, err
                if out:
                    out_parts.append(out.rstrip('\n'))
            return 0, '\n'.join(out_parts) + ('\n' if out_parts else ''), ''
        if cmd.startswith('echo '):
            text = cmd[5:].strip()
            if text.startswith('"') and text.endswith('"'):
                text = text[1:-1]
            return 0, text + '\n', ''
        if cmd.startswith('mkdir -p '):
            for m in re.findall(r'"([^"]+)"', cmd):
                os.makedirs(tr(m), exist_ok=True)
            return 0, '', ''
        if cmd.startswith('chmod '):
            return 0, '', ''
        if cmd.startswith('sh "'):
            m = re.search(r'^sh "([^"]+)"', cmd)
            script_path = tr(m.group(1))
            if os.path.isfile(script_path):
                return 0, 'sh:' + os.path.basename(script_path) + '\n', ''
            return 127, '', 'fake ssh: script not found: ' + script_path
        def tar_excludes(cmd):
            return re.findall(r'--exclude=([^ ]+)', cmd)

        def skip_member(member_name, excludes):
            parts = member_name.replace('\\', '/').split('/')
            for pattern in excludes:
                if pattern.startswith('*.') and member_name.endswith(pattern[1:]):
                    return True
                if pattern in parts:
                    return True
            return False

        m = re.search(r'tar -(czf|cf) "([^"]+)" -C "([^"]+)"', cmd)
        if m:
            flag, out, parent = m.groups()
            name_match = re.search(r'"([^"]+)"$', cmd)
            name = name_match.group(1) if name_match else ''
            out, parent = tr(out), tr(parent)
            excludes = tar_excludes(cmd)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with tarfile.open(out, 'w:gz' if flag == 'czf' else 'w') as tf:
                tf.add(os.path.join(parent, name), arcname=name,
                       filter=lambda member: None if skip_member(member.name, excludes) else member)
            return 0, '', ''
        m = re.search(r'tar -C "([^"]+)".*?-cf - \. \| tar -C "([^"]+)" -xf -', cmd)
        if m:
            src, dst = m.groups()
            src, dst = tr(src), tr(dst)
            excludes = tar_excludes(cmd)
            os.makedirs(dst, exist_ok=True)
            for root, dirs, files in os.walk(src):
                rel_root = os.path.relpath(root, src)
                rel_root = '' if rel_root == '.' else rel_root
                for d in list(dirs):
                    rel = (rel_root + '/' + d).lstrip('/')
                    if skip_member(rel, excludes):
                        dirs.remove(d)
                for fname in files:
                    rel = (rel_root + '/' + fname).lstrip('/')
                    if skip_member(rel, excludes):
                        continue
                    target_dir = os.path.join(dst, rel_root)
                    os.makedirs(target_dir, exist_ok=True)
                    shutil.copy2(os.path.join(root, fname), os.path.join(target_dir, fname))
            return 0, '', ''
        m = re.search(r'tar -(xzf|xf) "([^"]+)" -C "([^"]+)"', cmd)
        if m:
            flag, f, parent = m.groups()
            with tarfile.open(tr(f), 'r:gz' if flag == 'xzf' else 'r') as tf:
                tf.extractall(tr(parent), filter='data')
            return 0, '', ''
        if cmd.startswith('cp -a '):
            m = re.search(r'cp -a "([^"]+)" "([^"]+)"', cmd)
            src, dst = m.groups()
            src, dst = tr(src), tr(dst)
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
            return 0, '', ''
        if cmd.startswith('mv -f '):
            m = re.search(r'mv -f "([^"]+)" "([^"]+)"', cmd)
            src, dst = m.groups()
            src, dst = tr(src), tr(dst)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
            return 0, '', ''
        if cmd.startswith('unzip -oq '):
            m = re.search(r'unzip -oq "([^"]+)" -d "([^"]+)"', cmd)
            z, d = m.groups()
            with zipfile.ZipFile(tr(z)) as zf:
                zf.extractall(tr(d))
            return 0, '', ''
        if cmd.startswith('rm -rf '):
            for m in re.findall(r'"([^"]+)"', cmd):
                p = tr(m)
                if os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
                elif os.path.exists(p):
                    os.remove(p)
            return 0, '', ''
    except Exception as exc:  # noqa: BLE001
        return 127, '', 'fake ssh error: %s' % exc
    return 127, '', 'fake ssh: unsupported command: ' + cmd


class VFS(paramiko.SFTPServerInterface):
    """Filesystem-backed SFTP interface rooted at the virtual root."""

    def __init__(self, server):
        super().__init__(server)

    def list_folder(self, path):
        entries = []
        for name in os.listdir(tr(path)):
            st = os.stat(os.path.join(tr(path), name))
            entries.append(paramiko.SFTPAttributes.from_stat(st, name))
        return entries

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(os.stat(tr(path)))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def lstat(self, path):
        return self.stat(path)

    def open(self, path, flags, attr):
        f = paramiko.SFTPHandle(flags)
        f.filename = tr(path)
        os.makedirs(os.path.dirname(f.filename), exist_ok=True)
        if flags & (os.O_WRONLY | os.O_RDWR):
            f.writefile = open(f.filename, 'wb')
        if not flags & os.O_WRONLY:
            f.readfile = open(f.filename, 'rb')
        return f

    def remove(self, path):
        try:
            os.remove(tr(path))
            return paramiko.SFTP_OK
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def rmdir(self, path):
        try:
            os.rmdir(tr(path))
            return paramiko.SFTP_OK
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def mkdir(self, path, attr):
        try:
            os.makedirs(tr(path))
            return paramiko.SFTP_OK
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def rename(self, oldpath, newpath):
        try:
            os.rename(tr(oldpath), tr(newpath))
            return paramiko.SFTP_OK
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)


class Server(paramiko.ServerInterface):
    def __init__(self):
        self.lock = threading.Lock()
        self.exec_requests = {}  # chanid -> command text

    def check_channel_request(self, kind, chanid):
        if kind == 'session':
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL

    def check_auth_publickey(self, username, key):
        return paramiko.AUTH_SUCCESSFUL

    def get_allowed_auths(self, username):
        return 'password,publickey'

    def check_channel_exec_request(self, channel, command):
        with self.lock:
            self.exec_requests[channel.get_id()] = command.decode('utf-8')
        return True


def serve():
    os.makedirs(ROOT, exist_ok=True)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((HOST, PORT))
    sock.listen(8)
    print('fake ssh server listening on %s:%d root=%s' % (HOST, PORT, ROOT), flush=True)
    while True:
        conn, _addr = sock.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


def handle(conn):
    transport = paramiko.Transport(conn)
    transport.add_server_key(HOST_KEY)
    transport.set_subsystem_handler('sftp', paramiko.SFTPServer, sftp_si=VFS)
    server = Server()
    try:
        transport.start_server(server=server)
    except paramiko.SSHException:
        transport.close()
        return
    try:
        while transport.is_active():
            chan = transport.accept(5)
            if chan is None:
                continue
            deadline = time.time() + 1
            cmd = None
            while time.time() < deadline and transport.is_active() and not chan.closed:
                with server.lock:
                    cmd = server.exec_requests.pop(chan.get_id(), None)
                if cmd is not None:
                    break
                time.sleep(0.05)
            if cmd is None:
                continue  # sftp channel or closed before any exec request
            code, out, err = run_command(cmd)
            try:
                chan.sendall(out.encode('utf-8'))
                chan.sendall_stderr(err.encode('utf-8'))
                chan.send_exit_status(code)
            except OSError:
                pass
            try:
                chan.close()
            except OSError:
                pass
    finally:
        transport.close()


def time_sleep(seconds):
    import time
    time.sleep(seconds)


if __name__ == '__main__':
    serve()
