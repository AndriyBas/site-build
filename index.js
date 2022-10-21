const yaml = require("yaml");
const actionsCore = require("@actions/core");
const fetch = require("node-fetch"); // custom fetch, for Node on Actions
const fs = require("fs").promises;
const { PurgeCSS } = require("purgecss");
const { JSDOM } = require("jsdom");

const RETRY_COUNT = 3;
const RETRY_DELAY = 5 * 1000; // 5 sec

const CONFIG_FILE_NAME = "wfconfig.yml";

// TODO: refactor to use \w* instaed of [ \t\n]{0,}
const CSS_REGEX =
  /<link[ \t\n]{1,}href[ \t]{0,}=[ \t]{0,}"(https?:\/\/[0-9a-zA-Z\-\.\_\~]*(?:webflow\.com|website-files\.com)\/[^><]*\.css)"[ \t\n]{0,}.*?\/>/is;
const CSS_FILE_NAME = "style.css";
const cssReplaceString = (relPath) => {
  return `<link href="${relPath}${CSS_FILE_NAME}" rel="stylesheet" type="text/css"/>`;
};

const JS_REGEX =
  /<script[ \t\n]{1,}src[ \t]{0,}=[ \t]{0,}"(https?:\/\/[0-9a-zA-Z\-\.\_\~]*(?:webflow\.com|website-files\.com)\/[^><]*\.js)"[ \t\n]{0,}.*?><\/script>/is;
const JS_FILE_NAME = "script.js";
const jsReplaceString = (relPath) => {
  return `<script src="${relPath}${JS_FILE_NAME}" type="text/javascript"></script>`;
};

const JQUERY_REGEX =
  /<script[ \t\n]{1,}src[ \t]{0,}=[ \t]{0,}"(https:\/\/[0-9a-zA-Z\-\.\_\~]*cloudfront\.net\/js\/jquery[^><"]*)"[ \t\n]{0,}.*?><\/script>/i;
const JQUERY_FILE_NAME = "jquery.js";
const jQueryReplaceString = (relPath) => {
  return `<script src="${relPath}${JQUERY_FILE_NAME}" type="text/javascript"></script>`;
};

const CONTENT_DIR_NAME = "content";

const SITE_PROXY = "https://site-proxy-3.herokuapp.com"; // NOTE: NO "/" at the end

// write to current directory
if (!process.env["GITHUB_WORKSPACE"]) {
  process.env["GITHUB_WORKSPACE"] = process.cwd();
}

class RetryError extends Error {
  constructor() {
    super("Retrying function...");
    this.name = "RetryError";
  }
}

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
  console.log("On the target host: ", targetHost);

  console.log(
    `Action inputs:\n👉 REDIRECTS: \n${actionsCore.getInput("redirects")}`
  );
  console.log(`🐼 HEADERS: \n${actionsCore.getInput("headers")}`);
  console.log(`🤖 ROBOTS: \n${actionsCore.getInput("robots")}`);

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
  console.log("JQuery url: ", jqueryUrl);
  let jqueryPage = await fetchPage(jqueryUrl);
  await ghWriteFile(JQUERY_FILE_NAME, jqueryPage);

  // apply 'robots.txt' from input, or from config, or get from {site}/robots.txt (if available)
  let robots = actionsCore.getInput("robots") || config.robotsTxt;
  if (!robots) {
    robots = await fetchPage(`${site}/robots.txt`, true);
  }
  if (robots) await ghWriteFile("robots.txt", robots);

  // add Cloudflare _redirects (if configured). Docs - https://developers.cloudflare.com/pages/platform/redirects/
  const redirects = actionsCore.getInput("redirects") || config.redirects;
  if (redirects) {
    await ghWriteFile("_redirects", redirects);
  }

  // add Cloudflare _headers (if configured). Docs - https://developers.cloudflare.com/pages/platform/headers/
  const headers = actionsCore.getInput("headers") || config.headers;
  if (headers) {
    await ghWriteFile("_headers", headers);
  }

  // parse HTML pages
  const indexCode = await purgeAndEmbedHTML(
    "index",
    indexPage,
    cssPage,
    jsPage,
    site,
    targetHost
  );
  await ghWriteFile("index.html", indexCode);

  // TODO: get rid of it
  // const indexWithImg = await processImages(indexCode);
  // await ghWriteFile("index_img.html", indexWithImg);

  // return;

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
  sitemap = sitemap.replaceAll(site, targetHost); // replace any dev version with targetHost where present
  await ghWriteFile("sitemap.xml", sitemap);
  console.log("Total pages: ", pages.length);
  console.log("Pages: ", pages);

  const allPages = await Promise.all(
    pages.map((pagePath) =>
      getSinglePage(site, pagePath, cssPage, jsPage, site, targetHost)
    )
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
    console.log("\nFinished parsing successfully! 🙌");
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

async function getSinglePage(site, path, cssPage, jsPage, devHost, targetHost) {
  try {
    // let html = await retry(() => fetchPage(`${site}/${path}`));
    let html = await fetchPage(`${site}/${path}`);
    html = await purgeAndEmbedHTML(
      path,
      html,
      cssPage,
      jsPage,
      devHost,
      targetHost
    );
    return { path, html };
  } catch (error) {
    console.error(`Failed getting page ${path}: ${error.message}`);
    throw error;
  }
}

async function fetchPage(url, nullFor404 = false) {
  return await retry(
    async () => {
      // const response = await fetch(url);
      const response = await retry(() => fetch(url), RETRY_COUNT, Error); // retry any fetch error

      if (!response.ok) {
        if (nullFor404 && response.status === 404) return null;
        throw new RetryError(`${response.status}: ${response.statusText}`);
      }

      const body = await response.text();

      return body;
    },
    RETRY_COUNT,
    RetryError
  );
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

function generateProxyCode(devHost, targetHost) {
  return `<script>
  const { fetch: originalFetch } = window;
  window.fetch = async (...oArgs) => {
      let [oSrc, oConfig ] = oArgs;
      if (oSrc.indexOf('${targetHost}') >= 0) {
        let oUrl = new URL(oSrc);
        oSrc = "${SITE_PROXY}/${devHost}" + oUrl.pathname + oUrl.search;
      }
      const resp = await originalFetch(oSrc, oConfig);
      return resp;
  };
  </script>`;
}

async function processImages(html) {
  await enssurePathExists("assets/img");

  let newHtml = html;

  // match all <img /> first
  let matches = html.matchAll(
    /<img\s[^>]*?src\s*=\s*['\"]([^'\"]*?)['\"][^>]*?\/>/gi
  ); // TODO: needs /gis
  let i = 0;
  for (m of matches) {
    console.log("matches:", m[1]);

    const imgTag = m[0];
    let newImgTag = m[0];
    let allLinks = imgTag.matchAll(
      /https?:\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])/gis
    );
    for (l of allLinks) {
      console.log("link: ", l[0]);
      const imgUrl = l[0];
      let img = new RegExp(/\/([^\/]*)$/gi).exec(imgUrl)[1];

      let source = await retry(
        async () => {
          // const response = await fetch(url);
          const response = await retry(() => fetch(imgUrl), RETRY_COUNT, Error); // retry any fetch error

          if (!response.ok) {
            throw new RetryError(`${response.status}: ${response.statusText}`);
          }

          const body = await response.buffer();

          return body;
        },
        RETRY_COUNT,
        RetryError
      );
      // console.log('Source: ', source);

      await ghWriteFile(`assets/${img}`, source);

      newImgTag = newImgTag.replace(imgUrl, `./assets/${img}`);
    }

    newHtml = newHtml.replace(imgTag, newImgTag);

    i++;
    if (i >= 5) break;
  }

  return newHtml;
}

async function processImages2(html) {
  // get all links from the Home page
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const allImg = doc.querySelectorAll("img");

  await enssurePathExists("assets/img");

  for (let i = 0; i < 5; i++) {
    let img = new RegExp(/\/([^\/]*)$/gi).exec(allImg[i].src)[1];
    console.log("img: ", img);
    let imgUrl = allImg[i].src;
    console.log("imgUrl: ", imgUrl);

    let source = await retry(
      async () => {
        // const response = await fetch(url);
        const response = await retry(() => fetch(imgUrl), RETRY_COUNT, Error); // retry any fetch error

        if (!response.ok) {
          throw new RetryError(`${response.status}: ${response.statusText}`);
        }

        const body = await response.buffer();

        return body;
      },
      RETRY_COUNT,
      RetryError
    );
    // console.log('Source: ', source);

    await ghWriteFile(`assets/${img}`, source);
  }

  return html;
}

async function purgeAndEmbedHTML(
  path,
  htmlCode,
  cssCode,
  jsCode,
  devHost,
  targetHost
) {
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

  const proxyCode = generateProxyCode(devHost, targetHost);
  // replace the CSS
  text = text.replace(
    CSS_REGEX,
    `<style>${purgeCSSResults[0].css}</style>${proxyCode}`
  );

  // no minimization
  // text = text.replace(CSS_REGEX, `<style>${cssCode}</style>`);

  // use as separate file
  // text = text.replace(CSS_REGEX, cssReplaceString(getRelativePath(path)));

  // replace the JS
  text = text.replace(JS_REGEX, jsReplaceString(getRelativePath(path)));
  // replace the JQuery
  text = text.replace(JQUERY_REGEX, jQueryReplaceString(getRelativePath(path)));
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

async function retry(
  func,
  retryCount = RETRY_COUNT,
  errorType = RetryError,
  delay = RETRY_DELAY
) {
  try {
    return await func();
  } catch (error) {
    if (error instanceof errorType) {
      if (retryCount > 0) {
        await sleep(delay);
        return retry(func, retryCount - 1, errorType, delay);
      } else {
        throw new Error(
          `Too many retries, aborting. Original error: ${error.message}`
        );
      }
    } else {
      throw error;
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

function getRelativePath(path) {
  const count = (path.match(/\//g) || []).length;
  return count === 0 ? "./" : "../".repeat(count);
}
