// A copy of a page to start a similar one from. A plain function, so the editor and the tests share it.

// The copy: the same sections and settings under a new title, as a draft. A publishing date and an
// SEO title (which would name the original in browsers and search results) are not copied.
export function duplicatePage(page, title) {
  const copy = { ...structuredClone(page), title, status: 'draft' };
  delete copy.publish_date;
  if (copy.seo && typeof copy.seo === 'object') {
    delete copy.seo.title;
    if (!Object.keys(copy.seo).length) delete copy.seo;
  }
  return copy;
}
