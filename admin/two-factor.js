// Setting up two-factor sign-in, on the sign-in page (where the site requires it) and in "Mein
// Konto": the QR code and key for the authenticator app, a code and the password to confirm, then
// the recovery codes, shown once.
import { qrSVG } from './qr.js';
import { t } from './i18n.js';

const make = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
};

// The recovery codes with "Kopieren" and "Herunterladen", and a button to go on.
export function recoveryCodes(codes, siteName, onDone, done = t('twoFactor.codesKept')) {
  const text = `${t('twoFactor.codesFileTitle', { site: siteName })}\n${t('twoFactor.codesFileNote')}\n\n${codes.join('\n')}\n`;
  const copy = make('button', { type: 'button', className: 've-tool', textContent: t('copy') });
  copy.addEventListener('click', () => navigator.clipboard.writeText(text).then(() => { copy.textContent = t('copied'); }, () => {}));
  const download = make('a', { className: 've-tool', textContent: t('download'), download: t('twoFactor.codesFileName'), href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })) });
  const next = make('button', { type: 'button', className: 've-primary', textContent: done });
  next.addEventListener('click', onDone);
  return make('div', { className: 'werft-two-factor' },
    make('p', { textContent: t('twoFactor.codesLead') }),
    make('ol', { className: 'werft-codes' }, ...codes.map((c) => make('li', { textContent: c }))),
    make('div', { className: 've-actions-row' }, copy, download, next));
}

// Fills `container` with the steps. api(path, options) is the admin's gateway call; onDone gets the
// gateway's answer once two-factor sign-in is on.
export function setupTwoFactor(container, { api, siteName, onDone }) {
  const error = make('p', { className: 've-error werft-error', role: 'alert' });
  const begin = make('button', { type: 'button', className: 've-primary', textContent: t('twoFactor.setUp') });
  container.replaceChildren(
    make('p', { textContent: t('twoFactor.needApp') }),
    error, make('div', { className: 've-actions-row' }, begin));
  begin.addEventListener('click', async () => {
    error.textContent = '';
    let started;
    try { started = await api('/me/two-factor', { method: 'POST', body: { action: 'start' } }); } catch (e) { error.textContent = e.message; return; }
    const qr = make('div', { className: 'werft-qr' });
    // Too long an address for a QR code leaves the key to type in.
    try { qr.innerHTML = qrSVG(started.url, { label: t('twoFactor.qrLabel') }); } catch { qr.hidden = true; }
    const key = started.secret.match(/.{1,4}/g).join(' ');
    const code = make('input', { id: 'werft-2fa-code', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7, required: true });
    const password = make('input', { id: 'werft-2fa-password', type: 'password', autocomplete: 'current-password', required: true });
    const confirm = make('button', { type: 'submit', className: 've-primary', textContent: t('twoFactor.enable') });
    const label = (input, text) => make('div', { className: 've-control' }, make('label', { className: 've-label', htmlFor: input.id, textContent: text }), input);
    container.replaceChildren(
      make('p', { textContent: `${t('twoFactor.step1')} ` }, make('a', { href: started.url, textContent: t('twoFactor.openInApp') }), '.'),
      qr,
      make('p', { className: 've-hint' }, `${t('twoFactor.keyByHand')} `, make('code', { className: 'werft-key', textContent: key })),
      make('p', { textContent: t('twoFactor.step2') }),
      make('form', { className: 've-form ve-user-form' }, label(code, t('twoFactor.codeLabel')), label(password, t('twoFactor.yourPassword')), error, make('div', { className: 've-actions-row' }, confirm)));
    code.focus();
    confirm.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      error.textContent = '';
      try {
        const result = await api('/me/two-factor', { method: 'POST', body: { action: 'enable', pending: started.pending, code: code.value, current_password: password.value } });
        const done = make('p', { textContent: t('twoFactor.isOn'), tabIndex: -1 });
        container.replaceChildren(done, recoveryCodes(result.recovery_codes, siteName, () => onDone(result)));
        done.focus();
      } catch (e) {
        error.textContent = e.message;
        if (e.status === 410) container.replaceChildren(make('p', { className: 've-error', textContent: e.message }), begin, error);
      }
    });
  });
}
