// Forms for the editor, built from the field definitions of the admin schema: the side panel of the
// page view and the form view use the same controls. A form edits a value object in place and
// calls onChange after every change.
import { markdown } from 'werft';
import { toMarkdown, formatBar, editableAsRich } from './visual-rich.js';

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
};
const uid = () => `ve-${Math.random().toString(36).slice(2)}`;
// Controls that show another field of the same object (the focal point shows the image) redraw
// when that field changes.
const watchers = new WeakMap();
const watch = (holder, redraw) => { if (!watchers.has(holder)) watchers.set(holder, new Set()); watchers.get(holder).add(redraw); };
const changedIn = (holder) => watchers.get(holder)?.forEach((redraw) => redraw());

const optionsOf = (field) => (field.options ?? []).map((o) => (typeof o === 'object' ? o : { label: String(o), value: o }));

// A new, empty value for a field: its default, or nothing.
export function emptyValue(field) {
  if (field.default !== undefined) return structuredClone(field.default);
  if (field.widget === 'object') return Object.fromEntries((field.fields ?? []).map((f) => [f.name, emptyValue(f)]).filter(([, v]) => v !== undefined));
  if (field.widget === 'list') return [];
  if (field.widget === 'boolean') return false;
  return undefined;
}

// ctx: { onChange(), pickImage(current) → Promise<path|null>, mediaURL(path), choices(collection) → [{ label, value }],
//   suggest(field) → [{ label, value }] offered for a text field,
//   pickItem(field) → Promise<item|null>: a new entry of a list with several kinds,
//   openItems: Set of the list entries shown open (their paths as JSON), kept across redraws,
//   confirmRemove(label) → Promise<boolean>, asked before a list entry is removed,
//   radios: show a choice of up to four options as radio buttons }
// `path` is where `value` sits in the edited entry; list entries carry theirs as data-path.
export function buildForm(fields, value, ctx, path = []) {
  const form = el('div', { className: 've-form' });
  for (const field of fields) {
    if (field.widget === 'hidden') continue;
    form.append(control(field, value, ctx, [...path, field.name]));
  }
  return form;
}

function labelled(field, input, { inline = false, before = null } = {}) {
  const label = el('label', { className: 've-label', id: uid() }, field.label ?? field.name);
  if (/^(input|select|textarea)$/.test(input.localName)) { input.id = uid(); label.htmlFor = input.id; } else input.setAttribute('aria-labelledby', label.id);
  const hint = field.hint ? el('small', { className: 've-hint' }, field.hint) : null;
  return el('div', { className: `ve-control${inline ? ' ve-inline' : ''}` }, ...(inline ? [input, label] : [label, hint, before, input]), inline ? hint : null);
}

function control(field, holder, ctx, path) {
  const name = field.name;
  const set = (v) => {
    if (v === undefined || v === '') { if (field.required === false) delete holder[name]; else holder[name] = v ?? ''; } else holder[name] = v;
    ctx.onChange();
  };
  const current = holder[name];
  switch (field.widget) {
    case 'richtext': {
      // Formatted like on the page where the text allows it, else as Markdown.
      if (editableAsRich(current ?? '')) {
        const editor = el('div', { className: 've-rich', contentEditable: 'true', role: 'textbox', spellcheck: true });
        editor.setAttribute('aria-multiline', 'true');
        editor.innerHTML = markdown(current ?? '');
        editor.addEventListener('input', () => set(toMarkdown(editor)));
        editor.addEventListener('paste', (event) => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
        return labelled(field, editor, { before: formatBar(document, () => editor.dispatchEvent(new Event('input'))) });
      }
      const input = el('textarea', { value: current ?? '', rows: 8 });
      input.addEventListener('input', () => set(input.value));
      return labelled({ ...field, hint: field.hint ?? '**fett**, *kursiv*, [Link](adresse)' }, input);
    }
    case 'text': {
      const input = el('textarea', { value: current ?? '', rows: 3 });
      input.addEventListener('input', () => set(input.value));
      return labelled(field, input);
    }
    case 'number': {
      const input = el('input', { type: 'number', value: current ?? '' });
      input.addEventListener('input', () => set(input.value === '' ? undefined : Number(input.value)));
      return labelled(field, input);
    }
    case 'boolean': {
      const input = el('input', { type: 'checkbox', checked: !!current });
      input.addEventListener('change', () => { holder[name] = input.checked; ctx.onChange(); });
      return labelled(field, input, { inline: true });
    }
    case 'select': {
      const options = optionsOf(field);
      if (ctx.radios && options.length <= 4) {
        const group = el('div', { className: 've-radios', role: 'radiogroup' });
        const radioName = uid();
        for (const o of options) {
          const input = el('input', { type: 'radio', name: radioName, checked: o.value === (current ?? field.default) });
          input.addEventListener('change', () => set(o.value));
          group.append(el('label', { className: 've-radio' }, input, el('span', {}, o.label)));
        }
        return labelled(field, group);
      }
      const input = el('select');
      if (field.required === false || !options.some((o) => o.value === current)) input.append(el('option', { value: '' }, '–'));
      for (const o of options) input.append(el('option', { value: String(o.value), selected: o.value === current }, o.label));
      input.addEventListener('change', () => set(options.find((o) => String(o.value) === input.value)?.value));
      return labelled(field, input);
    }
    case 'relation': {
      const input = el('select');
      input.append(el('option', { value: '' }, '– bitte wählen –'));
      for (const o of ctx.choices(field.collection)) input.append(el('option', { value: o.value, selected: o.value === current }, o.label));
      input.addEventListener('change', () => set(input.value || undefined));
      return labelled(field, input);
    }
    case 'datetime': {
      const dateOnly = field.type === 'date';
      const input = el('input', { type: dateOnly ? 'date' : 'datetime-local' });
      if (current) {
        if (dateOnly) input.value = String(current).slice(0, 10);
        else { const d = new Date(current); if (!Number.isNaN(d.getTime())) input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
      }
      // Times are entered in the editor's time zone and stored in UTC.
      input.addEventListener('change', () => set(!input.value ? undefined : dateOnly ? input.value : new Date(input.value).toISOString()));
      return labelled(field, input);
    }
    case 'image': {
      const preview = el('img', { className: 've-thumb', alt: '' });
      const show = () => { preview.src = holder[name] ? ctx.mediaURL(holder[name]) : ''; preview.hidden = !holder[name]; };
      show();
      const button = el('button', { type: 'button', className: 've-button' }, holder[name] ? 'Bild ändern' : 'Bild wählen');
      button.addEventListener('click', async () => {
        const picked = await ctx.pickImage(holder[name]);
        if (picked) { set(picked); show(); button.textContent = 'Bild ändern'; changedIn(holder); }
      });
      return labelled(field, el('div', { className: 've-image-field' }, preview, button));
    }
    case 'focus': {
      // The point of the image that stays visible when the theme crops it: a click on the image
      // or the arrow keys set it, stored as "x% y%" for object-position.
      const image = el('img', { alt: '' });
      const dot = el('span', { className: 've-focus-dot' });
      const area = el('div', { className: 've-focus', tabIndex: 0, role: 'group' }, image, dot);
      const none = el('small', { className: 've-hint' }, 'Erst ein Bild wählen.');
      const reset = el('button', { type: 'button', className: 've-tool' }, 'Zurück zur Mitte');
      const point = () => (holder[name] ?? '50% 50%').split(' ').map((v) => parseFloat(v));
      const draw = () => {
        const src = holder[field.image ?? 'src'];
        if (src) image.src = ctx.mediaURL(src);
        area.hidden = !src;
        none.hidden = !!src;
        const [x, y] = point();
        dot.style.left = `${x}%`;
        dot.style.top = `${y}%`;
        area.setAttribute('aria-label', `Wichtiger Bildteil: ${Math.round(x)} % von links, ${Math.round(y)} % von oben. Pfeiltasten verschieben ihn.`);
        reset.hidden = !src || holder[name] === undefined;
      };
      const place = (x, y) => {
        const clamp = (v) => Math.round(Math.min(100, Math.max(0, v)));
        set(`${clamp(x)}% ${clamp(y)}%`);
        draw();
      };
      area.addEventListener('click', (event) => {
        const box = image.getBoundingClientRect();
        place(((event.clientX - box.left) / box.width) * 100, ((event.clientY - box.top) / box.height) * 100);
      });
      area.addEventListener('keydown', (event) => {
        const step = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] }[event.key];
        if (!step) return;
        event.preventDefault();
        const [x, y] = point();
        place(x + step[0], y + step[1]);
      });
      reset.addEventListener('click', () => { set(undefined); draw(); });
      watch(holder, draw);
      draw();
      return labelled(field, el('div', { className: 've-focus-field' }, area, none, reset));
    }
    case 'object': {
      // A missing group joins the content on its first edit, so opening a form changes nothing.
      const value = holder[name] ?? emptyValue(field) ?? {};
      const inner = buildForm(field.fields ?? [], value, { ...ctx, onChange: () => { holder[name] ??= value; ctx.onChange(); } }, path);
      if (field.collapsed) return el('details', { className: 've-details' }, el('summary', {}, field.label ?? name), inner);
      return el('fieldset', { className: 've-object' }, el('legend', {}, field.label ?? name), inner);
    }
    case 'list': return listControl(field, holder, ctx, path);
    default: {
      const input = el('input', { type: 'text', value: current ?? '' });
      input.addEventListener('input', () => set(input.value));
      // Addresses offer the site's pages; anything else can still be typed.
      const suggestions = ctx.suggest?.(field) ?? [];
      if (!suggestions.length) return labelled(field, input);
      const list = el('datalist', { id: uid() }, ...suggestions.map((o) => el('option', { value: o.value, label: o.label })));
      input.setAttribute('list', list.id);
      return el('div', {}, labelled(field, input), list);
    }
  }
}

// The text an entry is listed with: its summary template ({{fields.label}}), else its first text in
// the order of its fields (a chosen pattern or form by its name).
function summaryOf(def, item, ctx) {
  const plain = (v) => String(v).replace(/[*_#>[\]()`]/g, '').replace(/\s+/g, ' ').trim();
  if (def?.summary && item && typeof item === 'object') {
    const text = def.summary.replace(/\{\{fields\.(\w+)\}\}/g, (_, key) => (typeof item[key] === 'string' || typeof item[key] === 'number' ? item[key] : ''));
    if (plain(text.replace(/→/g, ''))) return plain(text);
  }
  if (typeof item !== 'object' || item === null) return plain(item ?? '');
  const first = (fields, value) => {
    for (const field of fields ?? []) {
      const v = value?.[field.name];
      if (v == null || v === '' || field.name === 'id') continue;
      if (field.widget === 'relation') return ctx.choices(field.collection).find((o) => o.value === v)?.label ?? plain(v);
      if (['string', 'text', 'richtext', undefined].includes(field.widget) && typeof v === 'string' && plain(v)) return plain(v);
      if (field.widget === 'object') { const f = first(field.fields, v); if (f) return f; }
      if (field.widget === 'list' && Array.isArray(v)) {
        for (const entry of v) { const f = field.field ? (typeof entry === 'string' ? plain(entry) : '') : first(field.fields, entry); if (f) return f; }
      }
    }
    return '';
  };
  return first(def?.fields, item);
}

function listControl(field, holder, ctx, path) {
  const typed = !!field.types;
  const typeOf = (item) => (typed ? field.types.find((t) => t.name === item?.[field.typeKey ?? 'type']) : null);
  const box = el('fieldset', { className: `ve-object ve-list${typed ? ' ve-typed' : ''}` }, el('legend', {}, field.label ?? field.name));
  const body = el('div', { className: 've-list-items' });
  box.append(body);
  const single = field.field;
  const openItems = ctx.openItems ?? new Set();
  const key = (i) => JSON.stringify([...path, i]);
  const label = (item, i) => {
    const type = typeOf(item);
    const text = summaryOf(type ?? field, item, ctx).slice(0, 80);
    return { kind: type?.label ?? (typed ? 'Abschnitt' : null), text: text || (typed ? '' : `Eintrag ${i + 1}`) };
  };
  // Moves the open state with an entry.
  const swapOpen = (i, j) => {
    const a = openItems.has(key(i)), b = openItems.has(key(j));
    openItems[b ? 'add' : 'delete'](key(i));
    openItems[a ? 'add' : 'delete'](key(j));
  };
  const draw = () => {
    const list = holder[field.name] ?? [];
    body.replaceChildren(...list.map((item, i) => {
      const { kind, text } = label(item, i);
      const title = el('span', { className: 've-list-title' }, kind ? el('strong', {}, kind) : null, el('span', {}, text));
      const tool = (glyph, words, fn, { disabled = false, danger = false } = {}) => {
        const b = el('button', { type: 'button', className: `ve-icon${danger ? ' ve-danger' : ''}`, title: words, disabled }, el('span', { 'aria-hidden': 'true' }, glyph), el('span', { className: 've-btn-text' }, words));
        b.setAttribute('aria-label', `${words}: ${kind ?? ''} ${text}`.trim());
        b.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if ((await fn()) === false) return;
          ctx.onChange();
          draw();
        });
        return b;
      };
      const tools = el('span', { className: 've-list-tools' },
        tool('↑', 'Nach oben', () => { swapOpen(i, i - 1); list.splice(i - 1, 0, ...list.splice(i, 1)); }, { disabled: i === 0 }),
        tool('↓', 'Nach unten', () => { swapOpen(i, i + 1); list.splice(i + 1, 0, ...list.splice(i, 1)); }, { disabled: i === list.length - 1 }),
        tool('✕', 'Entfernen', async () => {
          if (ctx.confirmRemove && !(await ctx.confirmRemove(`${kind ? `${kind}: ` : ''}${text}`))) return false;
          for (let j = i; j < list.length - 1; j++) swapOpen(j, j + 1);
          openItems.delete(key(list.length - 1));
          list.splice(i, 1);
        }, { danger: true }));
      const details = el('details', { className: 've-list-item', open: openItems.has(key(i)) }, el('summary', {}, title, tools));
      details.dataset.path = key(i);
      details.addEventListener('toggle', () => openItems[details.open ? 'add' : 'delete'](key(i)));
      const retitle = () => { const next = label(list[i], i); title.lastChild.textContent = next.text; };
      const type = typeOf(item);
      if (single) {
        const wrapper = { value: item };
        details.append(buildForm([{ ...single, name: 'value', label: single.label ?? field.label }], wrapper, { ...ctx, onChange: () => { list[i] = wrapper.value; retitle(); ctx.onChange(); } }, [...path, i]));
      } else {
        const fields = typed ? (type?.fields ?? []) : (field.fields ?? []);
        const inner = buildForm(fields, item, { ...ctx, onChange: () => { retitle(); ctx.onChange(); } }, [...path, i]);
        details.append(fields.length ? inner : el('p', { className: 've-hint' }, 'Dieser Abschnitt hat nichts einzustellen.'));
      }
      return details;
    }));
  };
  const add = el('button', { type: 'button', className: 've-button ve-add-item' }, typed ? `+ ${field.label === 'Abschnitte' ? 'Abschnitt' : 'Eintrag'} hinzufügen` : '+ Eintrag hinzufügen');
  add.addEventListener('click', async () => {
    let item;
    if (typed) {
      const picking = ctx.pickItem?.(field);
      item = picking ? await picking : { [field.typeKey ?? 'type']: field.types[0].name, ...emptyValue({ widget: 'object', fields: field.types[0].fields }) };
      if (!item) return;
    } else item = single ? (emptyValue(single) ?? '') : emptyValue({ widget: 'object', fields: field.fields });
    holder[field.name] ??= [];
    holder[field.name].push(item);
    openItems.add(key(holder[field.name].length - 1));
    ctx.onChange();
    draw();
    const last = body.lastElementChild;
    last?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    last?.querySelector('input, textarea, select, [contenteditable]')?.focus({ preventScroll: true });
  });
  box.append(add);
  draw();
  return box;
}
