/*
 * The browser tab's title. Pages set theirs through Next's `metadata`, which
 * the root layout's template finishes; a screen whose title depends on data
 * it reads in the browser renders React's `<title>` with `pageTitle`, so both
 * read the same way.
 */

export const SITE_NAME = 'First Paycheck';

/** The root layout's `metadata.title.template`. */
export const TITLE_TEMPLATE = `%s | ${SITE_NAME}`;

/** A page's full title, as the template writes it. */
export const pageTitle = (title: string) => TITLE_TEMPLATE.replace('%s', title);
