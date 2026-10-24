// The gateway's messages to the people who use the admin, per locale, with the admin's locales
// (admin/locales/): German first and the default, English. The admin sends its locale as
// Accept-Language; mail to a user goes out in the user's locale. A key a locale lacks gives the
// German message. Visitors of the site get the site's own texts (submissions.js).

const inMinutes = (minutes) => (minutes === 1 ? 'einer Minute' : `${minutes} Minuten`);
const de = {
  'signIn.wrong': 'E-Mail oder Passwort stimmt nicht.',
  'signIn.again': 'Bitte melden Sie sich noch einmal an.',
  'signIn.required': 'Bitte anmelden.',
  'tooMany.signIns': ({ minutes }) => `Zu viele Anmeldeversuche. Bitte in ${inMinutes(minutes)} noch einmal versuchen.`,
  'tooMany.attempts': ({ minutes }) => `Zu viele Versuche. Bitte in ${inMinutes(minutes)} noch einmal versuchen.`,
  'tooMany.requests': ({ minutes }) => `Zu viele Anfragen. Bitte in ${inMinutes(minutes)} noch einmal versuchen.`,
  'conflict.retry': 'Der Stand hat sich inzwischen geändert. Bitte noch einmal versuchen.',
  'conflict.reload': 'Der Stand hat sich inzwischen geändert. Bitte neu laden und erneut versuchen.',
  'conflict.save': 'Der Stand hat sich inzwischen geändert. Bitte neu laden.',
  'signOut.failed': 'Die Abmeldung hat nicht geklappt. Bitte noch einmal versuchen.',
  'twoFactor.wrongCode': 'Der Code stimmt nicht.',
  'twoFactor.wrongSetupCode': 'Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.',
  'twoFactor.already': 'Die Zwei-Faktor-Anmeldung ist schon eingerichtet.',
  'twoFactor.notSetUp': 'Die Zwei-Faktor-Anmeldung ist nicht eingerichtet.',
  'twoFactor.mandatory': 'Auf dieser Website ist die Zwei-Faktor-Anmeldung für Ihre Rolle Pflicht.',
  'twoFactor.expired': 'Die Einrichtung ist abgelaufen. Bitte noch einmal beginnen.',
  'twoFactor.setUpFirst': 'Bitte richten Sie zuerst die Zwei-Faktor-Anmeldung ein (Mein Konto).',
  unknownAction: 'Unbekannte Aktion.',
  'password.wrongCurrent': 'Das bisherige Passwort stimmt nicht.',
  'password.tooShort': 'Passwörter brauchen mindestens 10 Zeichen.',
  'email.invalid': 'Bitte eine gültige E-Mail-Adresse angeben.',
  'account.onlyOwn': 'Hier ändern Sie nur Ihren eigenen Namen, Ihre Sprache und Ihr Passwort.',
  'account.nameMissing': 'Bitte einen Namen angeben.',
  'account.nameTooLong': 'Der Name darf höchstens 100 Zeichen haben.',
  'account.localeUnknown': 'Diese Sprache gibt es für die Redaktion nicht.',
  'reset.noMail': 'Diese Website verschickt keine E-Mails. Ein Administrator kann Ihnen ein neues Passwort geben.',
  'reset.sent': 'Wenn es zu dieser Adresse ein Konto gibt, ist eine E-Mail mit einem Link unterwegs. Der Link gilt eine Stunde.',
  'reset.expired': 'Dieser Link gilt nicht mehr. Bitte fordern Sie einen neuen an.',
  'reset.subject': ({ site }) => `Neues Passwort für ${site ?? 'die Website'}`,
  'reset.text': ({ name, site, link }) => `Hallo ${name ?? ''},\n\njemand, hoffentlich Sie, möchte ein neues Passwort für ${site ?? 'die Website'} festlegen. Mit diesem Link geht das, eine Stunde lang und nur einmal:\n\n${link}\n\nWenn Sie das nicht waren, können Sie diese E-Mail löschen. Ihr Passwort bleibt dann, wie es ist.\n`,
  'save.tooMany': 'Bitte höchstens {count} Dateien auf einmal speichern oder hochladen.',
  'denied.private': 'Dieser Bereich ist geschützt.',
  'denied.adminsOnly': 'Nur Administratoren dürfen das ändern.',
  'denied.authorMedia': 'Autoren dürfen Medien nur hochladen.',
  'denied.authorOwn': 'Autoren dürfen nur eigene Beiträge ändern.',
  'denied.contributorOwn': 'Mitarbeiter dürfen nur eigene Beiträge ändern.',
  'denied.contributorStatus': 'Mitarbeiter dürfen Beiträge nur als Entwurf oder zur Prüfung speichern.',
  'denied.contributorPublished': 'Mitarbeiter dürfen veröffentlichte Beiträge nicht löschen.',
  'preview.onlyEntries': 'Vorschau-Links gibt es für Seiten und Beiträge.',
  'preview.noEntry': 'Diesen Eintrag gibt es nicht (mehr). Bitte erst speichern.',
  'preview.unavailable': 'Diese Website zeigt keine Vorschau-Links.',
  'preview.noLink': 'Diesen Link gibt es nicht (mehr).',
  'preview.title': 'Vorschau',
  'preview.gone': 'Dieser Vorschau-Link gilt nicht mehr.',
  'preview.down': 'Die Vorschau ist gerade nicht erreichbar. Bitte in ein paar Minuten noch einmal versuchen.',
  'users.adminsOnly': 'Nur Administratoren verwalten Benutzer.',
  'users.unknown': 'Unbekannter Benutzer.',
  'users.busy': 'Gerade melden sich viele ab. Bitte noch einmal versuchen.',
  'users.notSelf': 'Sie können sich nicht selbst löschen.',
  'users.noTwoFactor': 'Diese Person hat keine Zwei-Faktor-Anmeldung.',
  'users.ownTwoFactor': 'Ihre eigene Zwei-Faktor-Anmeldung schalten Sie unter „Mein Konto“ aus.',
  'users.unknownRole': 'Unbekannte Rolle.',
  'users.passwordMissing': 'Neue Benutzer brauchen ein Passwort.',
  'users.keepAdmin': 'Sie können sich die Administratorrolle nicht selbst nehmen.',
  'tick.failed': 'Veröffentlichen nach Zeitplan hat nicht geklappt. Bitte später noch einmal versuchen.',
  'tick.problem': 'Veröffentlichen nach Zeitplan: {reason}',
  'tick.actionsPermission': 'Die Berechtigung „Actions: Read and write“ für das Repository fehlt.',
  'tick.appPermission': 'Die GitHub App hat die Berechtigung „Actions: Read and write“ noch nicht, oder diese Installation hat sie noch nicht bestätigt.',
  'tick.noWorkflow': 'Den Workflow {workflow} gibt es im Repository nicht.',
  'tick.notStartable': 'Der Workflow {workflow} lässt sich auf {ref} nicht starten: ihm fehlt der Auslöser workflow_dispatch, oder den Branch {ref} gibt es nicht.',
  'submissions.notAllowed': 'Nur Administratoren und Redakteure sehen Einsendungen.',
  'submissions.noneChosen': 'Keine Einsendung ausgewählt.',
  'submissions.notFound': 'Einsendung {ref} nicht gefunden.',
  'submissions.subject': 'Neue Einsendung: {title}',
  'submissions.text': ({ title, fields, visitor }) => `Über das Formular „${title}“ kam eine neue Einsendung:\n\n${fields}\n\nAlle Einsendungen stehen im Editor unter „Einsendungen“.${visitor ? `\nEine Antwort auf diese E-Mail geht an ${visitor}.` : ''}\n`,
  internal: 'Interner Fehler im Gateway.',
};

const inMinutesEn = (minutes) => (minutes === 1 ? '1 minute' : `${minutes} minutes`);
const en = {
  'signIn.wrong': 'The email or the password is wrong.',
  'signIn.again': 'Please sign in again.',
  'signIn.required': 'Please sign in.',
  'tooMany.signIns': ({ minutes }) => `Too many sign-in attempts. Please try again in ${inMinutesEn(minutes)}.`,
  'tooMany.attempts': ({ minutes }) => `Too many attempts. Please try again in ${inMinutesEn(minutes)}.`,
  'tooMany.requests': ({ minutes }) => `Too many requests. Please try again in ${inMinutesEn(minutes)}.`,
  'conflict.retry': 'Something has changed in the meantime. Please try again.',
  'conflict.reload': 'Something has changed in the meantime. Please reload and try again.',
  'conflict.save': 'Something has changed in the meantime. Please reload.',
  'signOut.failed': 'Signing out did not work. Please try again.',
  'twoFactor.wrongCode': 'The code is wrong.',
  'twoFactor.wrongSetupCode': 'The code is wrong. Please enter the current code from the app.',
  'twoFactor.already': 'Two-factor sign-in is already set up.',
  'twoFactor.notSetUp': 'Two-factor sign-in is not set up.',
  'twoFactor.mandatory': 'On this website, two-factor sign-in is required for your role.',
  'twoFactor.expired': 'The setup has expired. Please start again.',
  'twoFactor.setUpFirst': 'Please set up two-factor sign-in first (My account).',
  unknownAction: 'Unknown action.',
  'password.wrongCurrent': 'The current password is wrong.',
  'password.tooShort': 'Passwords need at least 10 characters.',
  'email.invalid': 'Please enter a valid email address.',
  'account.onlyOwn': 'Here you change only your own name, your language and your password.',
  'account.nameMissing': 'Please enter a name.',
  'account.nameTooLong': 'The name may have at most 100 characters.',
  'account.localeUnknown': 'The admin is not available in this language.',
  'reset.noMail': 'This website does not send emails. An administrator can give you a new password.',
  'reset.sent': 'If there is an account for this address, an email with a link is on its way. The link works for one hour.',
  'reset.expired': 'This link no longer works. Please request a new one.',
  'reset.subject': ({ site }) => `New password for ${site ?? 'the website'}`,
  'reset.text': ({ name, site, link }) => `Hello ${name ?? ''},\n\nsomeone, hopefully you, wants to set a new password for ${site ?? 'the website'}. This link lets you do that, for one hour and only once:\n\n${link}\n\nIf this was not you, you can delete this email. Your password then stays as it is.\n`,
  'save.tooMany': 'Please save or upload at most {count} files at once.',
  'denied.private': 'This area is protected.',
  'denied.adminsOnly': 'Only administrators may change this.',
  'denied.authorMedia': 'Authors may only upload media.',
  'denied.authorOwn': 'Authors may only change their own posts.',
  'denied.contributorOwn': 'Contributors may only change their own posts.',
  'denied.contributorStatus': 'Contributors may only save posts as a draft or for review.',
  'denied.contributorPublished': 'Contributors may not delete published posts.',
  'preview.onlyEntries': 'Preview links exist for pages and posts.',
  'preview.noEntry': 'This entry does not exist (any more). Please save it first.',
  'preview.unavailable': 'This website does not show preview links.',
  'preview.noLink': 'This link does not exist (any more).',
  'preview.title': 'Preview',
  'preview.gone': 'This preview link no longer works.',
  'preview.down': 'The preview cannot be reached right now. Please try again in a few minutes.',
  'users.adminsOnly': 'Only administrators manage users.',
  'users.unknown': 'Unknown user.',
  'users.busy': 'Many people are signing out right now. Please try again.',
  'users.notSelf': 'You cannot delete yourself.',
  'users.noTwoFactor': 'This person has no two-factor sign-in.',
  'users.ownTwoFactor': 'You switch off your own two-factor sign-in under “My account”.',
  'users.unknownRole': 'Unknown role.',
  'users.passwordMissing': 'New users need a password.',
  'users.keepAdmin': 'You cannot take the administrator role away from yourself.',
  'tick.failed': 'Scheduled publishing did not work. Please try again later.',
  'tick.problem': 'Scheduled publishing: {reason}',
  'tick.actionsPermission': 'The permission “Actions: Read and write” for the repository is missing.',
  'tick.appPermission': 'The GitHub App does not have the permission “Actions: Read and write” yet, or this installation has not accepted it yet.',
  'tick.noWorkflow': 'The repository has no workflow {workflow}.',
  'tick.notStartable': 'The workflow {workflow} cannot be started on {ref}: it lacks the trigger workflow_dispatch, or the branch {ref} does not exist.',
  'submissions.notAllowed': 'Only administrators and editors see submissions.',
  'submissions.noneChosen': 'No submission selected.',
  'submissions.notFound': 'Submission {ref} not found.',
  'submissions.subject': 'New submission: {title}',
  'submissions.text': ({ title, fields, visitor }) => `A new submission came in through the form “${title}”:\n\n${fields}\n\nAll submissions are in the admin under “Submissions”.${visitor ? `\nA reply to this email goes to ${visitor}.` : ''}\n`,
  internal: 'Internal error in the gateway.',
};

export const MESSAGES = { de, en };
export const DEFAULT_LOCALE = 'de';

// The locale for a code ('en', 'en-GB') or an Accept-Language header ('en-GB,en;q=0.9,de;q=0.8'):
// the most preferred one the gateway has messages in, else German.
export function localeOf(value) {
  const wanted = String(value ?? '').split(',').map((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const q = Number(params.map((p) => p.trim()).find((p) => p.startsWith('q='))?.slice(2) ?? 1);
    return { code: tag.slice(0, 2).toLowerCase(), q: Number.isFinite(q) ? q : 0, i };
  }).filter((w) => w.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  return wanted.find((w) => Object.hasOwn(MESSAGES, w.code))?.code ?? DEFAULT_LOCALE;
}

// t(key, values) in a locale; a text may be a function of the values.
export function messages(locale) {
  const texts = MESSAGES[localeOf(locale)];
  return (key, values = {}) => {
    const text = texts[key] ?? de[key] ?? key;
    return typeof text === 'function' ? text(values) : text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : match));
  };
}

// The messages for a request, in the locale its Accept-Language asks for.
export const say = (request) => messages(request.headers.get('accept-language'));
