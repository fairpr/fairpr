import { builtinModules } from 'module';

// ---------- JavaScript / TypeScript ----------

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.split('/')[0]]));

const JS_IMPORT_RES: RegExp[] = [
  /^\s*import\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/,
  /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+['"]([^'"]+)['"]/,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/,
];

export function jsSpecifiers(line: string): string[] {
  const out: string[] = [];
  for (const re of JS_IMPORT_RES) {
    const m = line.match(re);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Returns the npm package name for a bare specifier, or undefined if it is not a package import. */
export function jsPackageName(spec: string, aliases: string[] = []): string | undefined {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return undefined; // node:, virtual:, bun:, https:, data: ...
  if (spec.startsWith('#') || spec.startsWith('$') || spec.startsWith('~') || spec.startsWith('@/')) return undefined;
  if (aliases.some((a) => a && (spec === a.replace(/\/\*?$/, '') || spec.startsWith(a.replace(/\*$/, ''))))) return undefined;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
  if (!name) return undefined;
  if (NODE_BUILTINS.has(name)) return undefined;
  return name;
}

// ---------- Python ----------

const PY_STDLIB = new Set(
  (
    'abc antigravity argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 cProfile calendar cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap modulefinder msvcrt multiprocessing netrc nt ntpath nturl2path numbers opcode operator optparse os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tabnanny tarfile tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo ' +
    // removed in recent Pythons but still found in older codebases
    '__future__ __main__ distutils imp asynchat asyncore smtpd cgi cgitb crypt imghdr mailcap nis nntplib ossaudiodev pipes sndhdr spwd sunau telnetlib uu xdrlib audioop chunk aifc msilib lib2to3 binhex formatter parser symbol _thread'
  ).split(/\s+/),
);

/** import name -> distribution names that provide it (normalised). */
const PY_ALIASES: Record<string, string[]> = {
  yaml: ['pyyaml'],
  cv2: ['opencv-python', 'opencv-python-headless', 'opencv-contrib-python', 'opencv-contrib-python-headless'],
  pil: ['pillow'],
  sklearn: ['scikit-learn'],
  skimage: ['scikit-image'],
  bs4: ['beautifulsoup4'],
  dateutil: ['python-dateutil'],
  dotenv: ['python-dotenv'],
  jwt: ['pyjwt'],
  jose: ['python-jose'],
  attr: ['attrs'],
  crypto: ['pycryptodome', 'pycryptodomex'],
  serial: ['pyserial'],
  magic: ['python-magic'],
  docx: ['python-docx'],
  pptx: ['python-pptx'],
  fitz: ['pymupdf'],
  telegram: ['python-telegram-bot'],
  openssl: ['pyopenssl'],
  zmq: ['pyzmq'],
  git: ['gitpython'],
  mysqldb: ['mysqlclient'],
  psycopg2: ['psycopg2-binary'],
  multipart: ['python-multipart'],
  slugify: ['python-slugify'],
  win32api: ['pywin32'],
  win32con: ['pywin32'],
  gi: ['pygobject'],
  usb: ['pyusb'],
  levenshtein: ['python-levenshtein', 'levenshtein'],
  ruamel: ['ruamel-yaml'],
  websocket: ['websocket-client'],
  socks: ['pysocks'],
  pkg_resources: ['setuptools'],
  mpl_toolkits: ['matplotlib'],
  google: ['protobuf'],
  dns: ['dnspython'],
  ldap: ['python-ldap'],
  lxml: ['lxml'],
  markdown: ['markdown'],
  nacl: ['pynacl'],
  sentencepiece: ['sentencepiece'],
  faiss: ['faiss-cpu', 'faiss-gpu'],
  tensorflow: ['tensorflow', 'tensorflow-cpu', 'tensorflow-gpu', 'tf-nightly'],
  torch: ['torch'],
  // Always present in any environment that installs packages; never "hallucinated".
  setuptools: ['*'],
  pip: ['*'],
  typing_extensions: ['*'],
  pytest: ['*'],
  _pytest: ['*'],
};

export function normalizePy(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export function pyImports(line: string): string[] {
  const out: string[] = [];
  const from = line.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/);
  if (from) out.push(from[1].split('.')[0]);
  const imp = line.match(/^\s*import\s+([A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*)\s*(#.*)?$/);
  if (imp) {
    for (const part of imp[1].split(',')) {
      const mod = part.trim().split(/\s+/)[0];
      if (mod) out.push(mod.split('.')[0]);
    }
  }
  return out;
}

/** True if the Python import `top` is provided by stdlib, a local module, or a declared dependency. */
export function pyImportKnown(top: string, deps: Set<string>, localModules: Set<string>): boolean {
  if (PY_STDLIB.has(top) || top.startsWith('_')) return true;
  // Provided by the build tool / test runner rather than declared as a dependency:
  // SCons build scripts (Godot), pytest plugins (pytest_homeassistant..., pytest_asyncio...).
  if (top === 'SCons' || top.startsWith('pytest_')) return true;
  if (localModules.has(top) || localModules.has(top.toLowerCase())) return true;
  const n = normalizePy(top);
  const aliases = PY_ALIASES[top.toLowerCase()] ?? [];
  if (aliases.includes('*')) return true;
  for (const d of deps) {
    const dn = normalizePy(d);
    if (dn === n || dn.startsWith(n + '-') || aliases.includes(dn)) return true;
  }
  return false;
}
