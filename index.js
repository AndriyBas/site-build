const yaml = require("yaml");
const actionsCore = require("@actions/core");
const fetch = require("node-fetch"); // custom fetch, for Node on Actions
const fs = require("fs").promises;
const { PurgeCSS } = require("purgecss");
const { JSDOM } = require("jsdom");

const RETRY_COUNT = 4;
const RETRY_DELAY = 5 * 1000; // 5 sec

const CONFIG_FILE_NAME = "wfconfig.yml";

const CSS_REGEX =
  /<link[ \t\n]{1,}href[ \t]{0,}=[ \t]{0,}"(https?:\/\/[0-9a-zA-Z\-\.\_\~]*(?:webflow\.com|website-files\.com)\/[^><]*\.css)"[ \t\n]{0,}.*?\/>/is;
const CSS_FILE_NAME = "style.css";
// const CSS_REPLACE_STRING_1 = `<link href="./${CSS_FILE_NAME}" rel="stylesheet" type="text/css"/>`;
// const CSS_REPLACE_STRING_2 = `<link href="../${CSS_FILE_NAME}" rel="stylesheet" type="text/css"/>`;

const JS_REGEX =
  /<script[ \t\n]{1,}src[ \t]{0,}=[ \t]{0,}"(https?:\/\/[0-9a-zA-Z\-\.\_\~]*(?:webflow\.com|website-files\.com)\/[^><]*\.js)"[ \t\n]{0,}.*?><\/script>/is;
const JS_FILE_NAME = "script.js";
const JS_REPLACE_STRING_1 = `<script src="./${JS_FILE_NAME}" type="text/javascript"></script>`;
const JS_REPLACE_STRING_2 = `<script src="../${JS_FILE_NAME}" type="text/javascript"></script>`;

const JQUERY_REGEX =
  /<script[ \t\n]{1,}src[ \t]{0,}=[ \t]{0,}"(https:\/\/[0-9a-zA-Z\-\.\_\~]*cloudfront\.net\/js\/jquery[^><"]*)"[ \t\n]{0,}.*?><\/script>/i;
const JQUERY_FILE_NAME = "jquery.js";
const JQUERY_REPLACE_STRING_1 = `<script src="./${JQUERY_FILE_NAME}" type="text/javascript"></script>`;
const JQUERY_REPLACE_STRING_2 = `<script src="../${JQUERY_FILE_NAME}" type="text/javascript"></script>`;

const CONTENT_DIR_NAME = "content";

// write to current directory
process.env["GITHUB_WORKSPACE"] = process.cwd();

async function init() {
  const configFile = await ghReadFile(CONFIG_FILE_NAME);

  const config = yaml.parse(configFile);
  if (!config.site) {
    throw new Error('❌ "site" is empty in config, aborting.');
  }
  if (!config.targetHost) {
    throw new Error('❌ "targetHost" is empty in config, aborting.');
  }
  //   console.log("config: ", config);

  return config;
}

async function buildSite(config) {
  const site = config.site.replace(/\/$/i, ""); // remove the "/" at the end (if any)
  const targetHost = config.targetHost.replace(/\/$/i, ""); // remove the "/" at the end (if any)
  console.log("Building the website: ", site);

  // create dir, remove previous files
  await dirCleanup();

  const indexPage = await fetchPage(site);

  // parse CSS
  const cssUrl = getCSSUrl(indexPage);
  console.log("CSS url: ", cssUrl);
  let cssPage = await fetchPage(cssUrl);
  // hide the badge
  cssPage += " .w-webflow-badge{display: none !important;}";
  await ghWriteFile(CSS_FILE_NAME, cssPage);

  // parse JS
  const jsUrl = getJSUrl(indexPage);
  console.log("JS url: ", jsUrl);
  let jsPage = await fetchPage(jsUrl);
  await ghWriteFile(JS_FILE_NAME, jsPage);

  // parse Jquery lib
  const jqueryUrl = getJqueryUrl(indexPage);
  console.log("Jquery url: ", jqueryUrl);
  let jqueryPage = await fetchPage(jqueryUrl);
  await ghWriteFile(JQUERY_FILE_NAME, jqueryPage);

  // apply 'robots.txt' from config, or get from {site}/robots.txt (if available)
  if (config.robotsTxt) {
    await ghWriteFile("robots.txt", config.robotsTxt);
  } else {
    const robots = await fetchPage(`${site}/robots.txt`, true);
    if (robots) await ghWriteFile("robots.txt", robots);
  }

  // add Cloudflare _redirects (if configured). Docs - https://developers.cloudflare.com/pages/platform/redirects/
  if (config.redirects) {
    await ghWriteFile("_redirects", config.redirects);
  }

  // parse HTML pages
  const indexCode = await purgeAndEmbedHTML(
    "index",
    indexPage,
    cssPage,
    jsPage
  );
  await ghWriteFile("index.html", indexCode);

  // all pages that will fetch
  let pages = [];

  let sitemap = await fetchPage(`${site}/sitemap.xml`, true);
  if (!sitemap) {
    console.log(
      `🤷‍♂️ Sitemap not found at ${site}/sitemap.xml. Will parse Home page and generate own Sitemap.` +
        " Add links <a href='/relative/path' style='display:none;'></a> on the Home page to fetch these pages and add them to sitemap." +
        " Add 'data-skip-sitemap' attribute to <a> to NOT add them to sitemap.xml."
    );

    // get all links from the Home page
    const sitemapLinks = getLinksFromPage(
      indexCode,
      targetHost,
      "data-skip-sitemap"
    );
    const fetchLinks = getLinksFromPage(indexCode, targetHost);

    sitemap = generateSitemap(targetHost, sitemapLinks); // without 404
    pages = [...fetchLinks, "404"];
  } else {
    // get pages from Sitemap
    pages = getPagesFromSitemap(sitemap);
    const allLinks = getLinksFromPage(indexCode, targetHost, "data-skip-fetch");
    pages = Array.from(new Set([...pages, ...allLinks]));
  }
  await ghWriteFile("sitemap.xml", sitemap);
  console.log("Total pages: ", pages.length);
  console.log("Pages: ", pages);

  const allPages = await Promise.all(
    pages.map((pagePath) => getSinglePage(site, pagePath, cssPage, jsPage))
  );

  for (const p of allPages) {
    await enssurePathExists(p.path);
    await ghWriteFile(`${p.path}.html`, p.html);
  }
}

async function main() {
  const config = await init();

  // TODO: add proper retryies and cleanup for parsing sites
  await buildSite(config);

  return config;
}

main()
  .then(() => {
    console.log("Finished parsing successfully! 🙌");
  })
  .catch((error) => {
    console.error(error);
    actionsCore.setFailed(error);
  });

// ============================================
// Util functions
// ============================================

async function ghReadFile(fileName) {
  return await fs.readFile(`${process.env.GITHUB_WORKSPACE}/${fileName}`, {
    encoding: "utf8",
  });
}

async function ghWriteFile(fileName, content) {
  return await fs.writeFile(
    `${process.env.GITHUB_WORKSPACE}/${CONTENT_DIR_NAME}/${fileName}`,
    content
  );
}

async function dirCleanup() {
  await fs.rm(`${process.env.GITHUB_WORKSPACE}/${CONTENT_DIR_NAME}`, {
    recursive: true,
    force: true,
  });
  await fs.mkdir(`${CONTENT_DIR_NAME}`);
}

function getPagesFromSitemap(sitemap) {
  let pages = [
    ...sitemap.matchAll(/<loc>[ \t\n]{0,}([^>< \t\n]*)[ \t\n]{0,}<\/loc>/gis),
  ];
  pages = pages
    .map((p) => p[1])
    // remove the host and the last "/"
    .map((url) => url.replace(/^https?:\/\/[^\/]+\//, "").replace(/\/$/gi, ""))
    // filter out the index page
    .filter((page) => page);
  return [...pages, "404"];
}

function getLinksFromPage(pageCode, targetHost, skipByAttr) {
  // get all links from the Home page
  const dom = new JSDOM(pageCode);
  const doc = dom.window.document;
  const allLinks = doc.querySelectorAll("a");
  const pages = new Set();
  for (l of allLinks) {
    try {
      const u = new URL(l.href, targetHost);
      if (u.href.indexOf(targetHost) >= 0 && u.pathname !== "/") {
        if (!skipByAttr || !l.hasAttribute(skipByAttr)) {
          pages.add(u.pathname.replace(/^\//i, "")); // remove the "/" in the beginning (if present)
        }
      }
    } catch (e) {
      // ignore
    }
  }
  return Array.from(pages);
}

async function getSinglePage(site, path, cssPage, jsPage) {
  try {
    // let html = await retry(() => fetchPage(`${site}/${path}`), RETRY_COUNT);
    let html = await fetchPage(`${site}/${path}`);
    html = await purgeAndEmbedHTML(path, html, cssPage, jsPage);
    return { path, html };
  } catch (error) {
    console.error(`Failed getting page ${path}: ${error.message}`);
    throw error;
  }
}

async function fetchPage(url, nullFor404 = false) {
  return await retry(async () => {
    // const response = await fetch(url);
    const response = await retry(() => fetch(url), RETRY_COUNT);

    if (!response.ok) {
      if (nullFor404 && response.status === 404) return null;
      throw new Error(`${response.status}: ${response.statusText}`);
    }

    const body = await response.text();

    return body;
  }, RETRY_COUNT);
}

function getCSSUrl(index) {
  const cssMatch = index.match(CSS_REGEX);

  if (!cssMatch) {
    throw new Error("CSS file not found");
  }

  return cssMatch[1];
}

function getJSUrl(index) {
  const jsMatch = index.match(JS_REGEX);

  if (!jsMatch) {
    throw new Error("JS file not found");
  }
  return jsMatch[1];
}

function getJqueryUrl(index) {
  const jsMatch = index.match(JQUERY_REGEX);

  if (!jsMatch) {
    throw new Error("Jquery file not found");
  }
  return jsMatch[1];
}

async function purgeAndEmbedHTML(path, htmlCode, cssCode, jsCode) {
  // let text = prettier.format(html, { parser: "html" });
  let text = htmlCode;
  const purgeCSSResults = await new PurgeCSS().purge({
    content: [
      {
        raw: htmlCode,
        extension: "html",
      },
      {
        raw: jsCode,
        extension: "js",
      },
    ],
    css: [
      {
        raw: cssCode,
      },
    ],
  });
  // insert newline after the Timestamp, to have cleaner Git history
  text = text.replace(/<html /im, "\n<html ");

  // replace the CSS
  text = text.replace(CSS_REGEX, `<style>${purgeCSSResults[0].css}</style>`);
  // replace the JS
  text = text.replace(
    JS_REGEX,
    path.includes("/") ? JS_REPLACE_STRING_2 : JS_REPLACE_STRING_1
  );
  // replace the JQuery
  text = text.replace(
    JQUERY_REGEX,
    path.includes("/") ? JQUERY_REPLACE_STRING_2 : JQUERY_REPLACE_STRING_1
  );
  return text;
}

function generateSitemap(targetHost, pages) {
  // empty string — for the Home page
  let sitemap = ["", ...pages].reduce(
    (acc, current) =>
      `${acc}\n\t<url>\n\t\t<loc>${targetHost}/${current}</loc>\n\t</url>`,
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  );
  return sitemap + "\n</urlset>";
}

async function retry(func, retryCount = 0, delay = RETRY_DELAY) {
  try {
    return await func();
  } catch (error) {
    if (retryCount > 0) {
      await sleep(delay);
      return retry(func, retryCount - 1, delay);
    } else {
      throw new Error(
        `Too many retries, aborting. Original error: ${error.message}`
      );
    }
  }
}

// custom sleep, for Node on Actions
function sleep(timeout) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

async function enssurePathExists(path) {
  let parts = path.split("/").filter((part) => part);
  parts = parts.slice(0, parts.length - 1);

  let current = "";

  for (const part of parts) {
    current += `/${part}`;
    if (!(await pathExists(current))) {
      await fs.mkdir(
        `${process.env.GITHUB_WORKSPACE}/${CONTENT_DIR_NAME}${current}`
      );
    }
  }
}

async function pathExists(path) {
  if (path.startsWith("/")) {
    path = path.substring(1);
  }

  try {
    await fs.access(
      `${process.env.GITHUB_WORKSPACE}/${CONTENT_DIR_NAME}/${path}`
    );
    return true;
  } catch (error) {
    return false;
  }
}
