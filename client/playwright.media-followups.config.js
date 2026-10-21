import base from './playwright.config.js';
// Keep these focused checks isolated from an existing local dev server.
export default {
  ...base, timeout:120000, expect:{timeout:20000}, testMatch:'media-followups.spec.js', outputDir:'./e2e/test-results/followups',
  projects:base.projects.filter(project=>project.name.startsWith('app-')).map(project=>({...project,use:{...project.use,baseURL:'http://localhost:5181'}})),
  webServer:[{...base.webServer[0],command:'npm run dev -- --port 5181',url:'http://localhost:5181'}],
};
