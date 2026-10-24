<?php
// werft publish receiver for PHP web space (IONOS and other shared hosting without Node).
// `werft publish` sends the built site here; this file writes it into its own directory.
// It only ever changes or deletes files it wrote itself, so other files in the web space stay.
//
// Install: copy this file into the web root, set the secret below to the value of
// WERFT_PUBLISH_SECRET (make one with `npx werft secret`), and set WERFT_PUBLISH_URL to this
// file's URL on the build host. Requires PHP 7.4 or newer.

const WERFT_PUBLISH_SECRET = 'replace-with-the-output-of-werft-secret';

const MANIFEST = __DIR__ . '/werft-publish-manifest.php';
const MAX_AGE = 300;

function reply(int $status, array $data): void {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  exit;
}

function manifest(): array {
  return is_file(MANIFEST) ? (include MANIFEST) : [];
}

// A path the publisher may write: relative, no "..", not this file or its manifest, no code.
function safe_path(string $path): bool {
  if ($path === '' || strlen($path) > 1024 || strpbrk($path, "\\\0:") !== false || $path[0] === '/') return false;
  foreach (explode('/', $path) as $segment) if ($segment === '' || $segment === '.' || $segment === '..') return false;
  if (in_array($path, [basename(__FILE__), basename(MANIFEST)], true)) return false;
  return !preg_match('/\.(php\d?|phtml|phar|pht|phps|cgi|pl|py|sh|user\.ini)$|(^|\/)\.user\.ini$/i', $path);
}

// .htaccess may only hold redirects and a local not-found page (werft writes both there); anything
// else could make the server run uploaded files as code.
function safe_content(string $path, string $data): bool {
  if (basename($path) !== '.htaccess') return true;
  foreach (preg_split('/\r?\n/', $data) as $line) {
    $line = trim($line);
    if ($line !== '' && $line[0] !== '#' && !preg_match('/^(Redirect|RedirectMatch|RedirectPermanent|RedirectTemp)\s/i', $line)
      && !preg_match('#^ErrorDocument\s+404\s+/[^\s"]*\.html$#i', $line)) return false;
  }
  return true;
}

// Whether writing or deleting $path stays in this directory: no symbolic link on the way, so a link
// placed in the web space cannot redirect a write elsewhere.
function contained(string $path): bool {
  $root = realpath(__DIR__);
  for ($p = $path; $p !== '.'; $p = dirname($p)) if (is_link(__DIR__ . '/' . $p)) return false;
  for ($dir = dirname(__DIR__ . '/' . $path); !file_exists($dir); $dir = dirname($dir));
  $real = realpath($dir);
  return $real === $root || strpos($real, $root . '/') === 0;
}

function write_atomic(string $file, string $data): void {
  $dir = dirname($file);
  if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) throw new RuntimeException("Cannot create $dir");
  $tmp = $dir . '/.werft-' . bin2hex(random_bytes(6));
  if (file_put_contents($tmp, $data) !== strlen($data) || !rename($tmp, $file)) { @unlink($tmp); throw new RuntimeException("Cannot write $file"); }
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') reply(405, ['message' => 'POST only']);
if (strlen(WERFT_PUBLISH_SECRET) < 32 || strpos(WERFT_PUBLISH_SECRET, 'replace-with') === 0) reply(500, ['message' => 'Set WERFT_PUBLISH_SECRET in werft-publish.php.']);

// Signature: "t=<unix time>,s=<hex HMAC-SHA256 of '<t>\n<body>'>".
$body = file_get_contents('php://input');
$signature = $_SERVER['HTTP_X_WERFT_SIGNATURE'] ?? '';
if (!preg_match('/^t=(\d+),s=([0-9a-f]{64})$/', $signature, $m) || abs(time() - (int) $m[1]) > MAX_AGE
  || !hash_equals(hash_hmac('sha256', $m[1] . "\n" . $body, WERFT_PUBLISH_SECRET), $m[2])) reply(401, ['message' => 'Bad signature']);

$request = json_decode($body, true);
if (!is_array($request)) reply(400, ['message' => 'Bad request']);

try {
  switch ($request['action'] ?? '') {
    case 'manifest':
      reply(200, ['files' => (object) manifest()]);
    case 'put':
      $known = manifest();
      $written = 0;
      foreach ($request['files'] ?? [] as $file) {
        $path = (string) ($file['path'] ?? '');
        $data = base64_decode((string) ($file['content'] ?? ''), true);
        if (!safe_path($path) || $data === false || !safe_content($path, $data) || !contained($path)) reply(422, ['message' => "Refused: $path"]);
        $target = __DIR__ . '/' . $path;
        // A file werft did not publish is only taken over when it already has the same content.
        if (file_exists($target) && !isset($known[$path]) && (!is_file($target) || hash_file('sha256', $target) !== hash('sha256', $data))) {
          if ($written) write_atomic(MANIFEST, "<?php return " . var_export($known, true) . ";\n");
          reply(409, ['message' => "$path exists and was not published by werft; remove it from the web space first."]);
        }
        write_atomic($target, $data);
        $known[$path] = hash('sha256', $data);
        $written++;
      }
      // Recorded right away, so an interrupted publish can continue where it stopped.
      write_atomic(MANIFEST, "<?php return " . var_export($known, true) . ";\n");
      reply(200, ['written' => $written]);
    case 'delete':
      $known = manifest();
      $deleted = 0;
      foreach ($request['paths'] ?? [] as $path) {
        $path = (string) $path;
        if (!isset($known[$path]) || !safe_path($path) || !contained($path)) continue;
        if (is_file(__DIR__ . '/' . $path) && unlink(__DIR__ . '/' . $path)) $deleted++;
        for ($dir = dirname($path); $dir !== '.' && @rmdir(__DIR__ . '/' . $dir); $dir = dirname($dir));
      }
      reply(200, ['deleted' => $deleted]);
    case 'done':
      $files = [];
      foreach ($request['files'] ?? [] as $path => $hash) if (safe_path((string) $path) && preg_match('/^[0-9a-f]{64}$/', (string) $hash)) $files[(string) $path] = (string) $hash;
      write_atomic(MANIFEST, "<?php return " . var_export($files, true) . ";\n");
      reply(200, ['files' => count($files)]);
    default:
      reply(400, ['message' => 'Unknown action']);
  }
} catch (Throwable $e) {
  reply(500, ['message' => $e->getMessage()]);
}
