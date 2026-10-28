import login from '../netlify/functions/login.ts';

// Web-standard exports opt into Vercel's Node.js streaming request/response path.
export default { fetch: login };
