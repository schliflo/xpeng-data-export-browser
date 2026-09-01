// Every page is static: the app has no server routes and no server state.
// The export is read and analysed entirely in the browser, which is what makes
// the privacy claim on the landing page true rather than merely a policy.
export const prerender = true;
export const ssr = true;
