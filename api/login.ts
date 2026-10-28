import login from '../netlify/functions/login.js';

// Web-standard exports opt into Vercel's Node.js streaming request/response path.
export default { fetch: login };
