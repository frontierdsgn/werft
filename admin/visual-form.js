// Form for the side panel of the visual editor, built from the same field definitions the theme
// gives the CMS. It edits a value object in place and calls onChange after every change.

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
};

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
//   suggest(field) → [{ label, value }] offered for a text field }
export function buildForm(fields, value, ctx) {
  const form = el('div', { className: 've-form' });
  for (const field of fields) {
    if (field.widget === 'hidden') continue;
    form.append(control(field, value, ctx));
  }
  return form;
}

function labelled(field, input, { inline = false } = {}) {
  const id = `ve-${Math.random().toString(36).slice(2)}`;
  input.id = id;
  const label = el('label', { htmlFor: id, className: 've-label' }, field.label ?? field.name);
  const hint = field.hint ? el('small', { className: 've-hint' }, field.hint) : null;
  return el('div', { className: `ve-control${inline ? ' ve-inline' : ''}` }, ...(inline ? [input, label] : [label, input]), hint);
}

function control(field, holder, ctx) {
  const name = field.name;
  const set = (v) => {
    if (v === undefined || v === '') { if (field.required === false) delete holder[name]; else holder[name] = v ?? ''; } else holder[name] = v;
    ctx.onChange();
  };
  const current = holder[name];
  switch (field.widget) {
    case 'text': case 'richtext': {
      const input = el('textarea', { value: current ?? '', rows: field.widget === 'richtext' ? 6 : 3 });
      input.addEventListener('input', () => set(input.value));
      return labelled(field.widget === 'richtext' ? { ...field, hint: field.hint ?? '**fett**, *kursiv*, [Link](adresse)' } : field, input);
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
      const input = el('select');
      const options = optionsOf(field);
      if (field.required === false || !options.some((o) => o.value === current)) input.append(el('option', { value: '' }, '–'));
      for (const o of options) input.append(el('option', { value: String(o.value), selected: o.value === current }, o.label));
      input.addEventListener('change', () => set(options.find((o) => String(o.value) === input.value)?.value));
      return labelled(field, input);
    }
    case 'relation': {
      const input = el('select');
      input.append(el('option', { value: '' }, '–'));
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
      // Times are entered in the editor's time zone and stored in UTC, as in the CMS.
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
        if (picked) { set(picked); show(); button.textContent = 'Bild ändern'; }
      });
      return labelled(field, el('div', { className: 've-image-field' }, preview, button));
    }
    case 'object': {
      if (holder[name] == null) holder[name] = emptyValue(field) ?? {};
      const inner = buildForm(field.fields ?? [], holder[name], ctx);
      if (field.collapsed) return el('details', { className: 've-details' }, el('summary', {}, field.label ?? name), inner);
      return el('fieldset', { className: 've-object' }, el('legend', {}, field.label ?? name), inner);
    }
    case 'list': {
      if (field.types) return el('p', { className: 've-hint' }, `${field.label}: direkt auf der Seite bearbeiten.`);
      return listControl(field, holder, ctx);
    }
    default: {
      const input = el('input', { type: 'text', value: current ?? '' });
      input.addEventListener('input', () => set(input.value));
      // Addresses offer the site's pages; anything else can still be typed.
      const suggestions = ctx.suggest?.(field) ?? [];
      if (!suggestions.length) return labelled(field, input);
      const list = el('datalist', { id: `ve-${Math.random().toString(36).slice(2)}` }, ...suggestions.map((o) => el('option', { value: o.value, label: o.label })));
      input.setAttribute('list', list.id);
      return el('div', {}, labelled(field, input), list);
    }
  }
}

function listControl(field, holder, ctx) {
  const box = el('fieldset', { className: 've-object ve-list' }, el('legend', {}, field.label ?? field.name));
  const body = el('div');
  box.append(body);
  const single = field.field;
  const summary = (item, i) => {
    if (single) return String(item ?? '') || `Eintrag ${i + 1}`;
    const first = Object.values(item ?? {}).find((v) => typeof v === 'string' && v.trim());
    return first ?? `Eintrag ${i + 1}`;
  };
  const draw = () => {
    const list = holder[field.name] ?? [];
    body.replaceChildren(...list.map((item, i) => {
      const head = el('div', { className: 've-list-head' });
      const title = el('span', {}, summary(item, i));
      const button = (text, label, fn, disabled = false) => {
        const b = el('button', { type: 'button', className: 've-icon', title: label, disabled }, text);
        b.setAttribute('aria-label', label);
        b.addEventListener('click', (e) => { e.preventDefault(); fn(); ctx.onChange(); draw(); });
        return b;
      };
      head.append(title,
        button('↑', 'Nach oben', () => list.splice(i - 1, 0, ...list.splice(i, 1)), i === 0),
        button('↓', 'Nach unten', () => list.splice(i + 1, 0, ...list.splice(i, 1)), i === list.length - 1),
        button('✕', 'Entfernen', () => list.splice(i, 1)));
      const details = el('details', { className: 've-list-item' }, el('summary', {}, head));
      const wrapper = { value: item };
      details.append(single ? buildForm([{ ...single, name: 'value', label: single.label ?? field.label }], wrapper, { ...ctx, onChange: () => { list[i] = wrapper.value; title.textContent = summary(list[i], i); ctx.onChange(); } })
        : buildForm(field.fields ?? [], item, { ...ctx, onChange: () => { title.textContent = summary(item, i); ctx.onChange(); } }));
      return details;
    }));
  };
  const add = el('button', { type: 'button', className: 've-button' }, '+ Eintrag hinzufügen');
  add.addEventListener('click', () => {
    holder[field.name] ??= [];
    holder[field.name].push(single ? (emptyValue(single) ?? '') : emptyValue({ widget: 'object', fields: field.fields }));
    ctx.onChange();
    draw();
    body.lastElementChild?.setAttribute('open', '');
  });
  box.append(add);
  draw();
  return box;
}
