const yaml = require("yaml");
const actionsCore = require("@actions/core");
const fetch = require("node-fetch"); // custom fetch, for Node on Actions
const fs = require("fs").promises;
const { PurgeCSS } = require("purgecss");
const { JSDOM } = require("jsdom");

const RETRY_COUNT = 3;
const RETRY_DELAY = 5 * 1000; // 5 sec

const CONFIG_FILE_NAME = "wfconfig.yml";

const CSS_REGEX = new RegExp(
  /<link\s+[^>]*?href\s*=\s*['\"](https?:\/\/[\w\-\.\~]*(?:webflow\.com|website-files\.com)\/[^'\"]*?\.css[^'\"]*?)['\"].*?\/>/,
  "is"
);
const CSS_FILE_NAME = "style.css";
const cssReplaceString = (relPath) => {
  return `<link href="${relPath}${CSS_FILE_NAME}" rel="stylesheet" type="text/css"/>`;
};

const JS_REGEX = new RegExp(
  /<script\s+[^>]*?src\s*=\s*['\"](https?:\/\/[\w\-\.\~]*?(?:webflow\.com|website-files\.com)\/[^'\"]*?\.js[^'\"]*?)['\"].*?><\/script>/,
  "is"
);
const JS_FILE_NAME = "script.js";
const jsReplaceString = (relPath) => {
  return `<script src="${relPath}${JS_FILE_NAME}" type="text/javascript"></script>`;
};

const JQUERY_REGEX = new RegExp(
  /<script\s+[^>]*?src\s*=\s*['\"](https:\/\/[\w\-\.\~]*?cloudfront\.net\/js\/jquery[^'\"]*?)['\"].*?><\/script>/,
  "is"
);
const JQUERY_FILE_NAME = "jquery.js";
const jQueryReplaceString = (relPath) => {
  return `<script src="${relPath}${JQUERY_FILE_NAME}" type="text/javascript"></script>`;
};

const CONTENT_DIR_NAME = "content"; // whole site content
const ASSETS_DIR_NAME = "sb_assets"; // for dynamic fetched assets (images)
const STATIC_ASSETS_DIR_NAME = "sb_static"; // for static assets that persist (not deleted)

const ATTR = {
  skipSitemap: "data-sb-skip-sitemap",
  skipFetch: "data-sb-skip-fetch",
  processImg: "data-sb-process-img",
};

const SITE_PROXY = "https://site-proxy-3.herokuapp.com"; // NOTE: NO "/" at the end

// TODO: consider replacing images everywhere, not only on the current page
// set to track downloaded images and not re-fetch them
const PROCESSED_IMAGES = new Set();

// write to current directory
if (!process.env["GITHUB_WORKSPACE"]) {
  process.env["GITHUB_WORKSPACE"] = process.cwd();
}

class RetryError extends Error {
  constructor(message) {
    super(message);
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
  console.log("🎨 CSS url: ", cssUrl);
  let cssPage = await fetchPage(cssUrl);
  // hide the badge
  cssPage += " .w-webflow-badge{display: none !important;}";
  await ghWriteFile(CSS_FILE_NAME, cssPage);

  // parse JS
  const jsUrl = getJSUrl(indexPage);
  console.log("⚙️ JS url: ", jsUrl);
  let jsPage = await fetchPage(jsUrl);
  await ghWriteFile(JS_FILE_NAME, jsPage);

  // parse Jquery lib
  const jqueryUrl = getJqueryUrl(indexPage);
  console.log("🧱 JQuery url: ", jqueryUrl);
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

  // all pages that will fetch
  let pages = [];

  let sitemap = await fetchPage(`${site}/sitemap.xml`, true);
  if (!sitemap) {
    console.log(
      `🤷‍♂️ Sitemap not found at ${site}/sitemap.xml. Will parse Home page and generate own Sitemap.` +
        " Add links <a href='/relative/path' style='display:none;'></a> on the Home page to fetch these pages and add them to sitemap." +
        ` Add '${ATTR.skipSitemap}' attribute to <a> to NOT add them to sitemap.xml.`
    );

    // get all links from the Home page
    const sitemapLinks = getLinksFromPage(
      indexCode,
      targetHost,
      ATTR.skipSitemap
    );
    const fetchLinks = getLinksFromPage(indexCode, targetHost);

    sitemap = generateSitemap(targetHost, sitemapLinks); // without 404
    pages = [...fetchLinks, "404"];
  } else {
    // get pages from Sitemap
    pages = getPagesFromSitemap(sitemap);
    const allLinks = getLinksFromPage(indexCode, targetHost, ATTR.skipFetch);
    pages = Array.from(new Set([...pages, ...allLinks]));
  }
  sitemap = sitemap.replaceAll(site, targetHost); // replace any dev version with targetHost where present
  await ghWriteFile("sitemap.xml", sitemap);
  console.log("Total pages: ", pages.length);
  console.log("Pages: ", pages);

  // for (pagePath of pages) {
  //   const p = await getSinglePage(
  //     site,
  //     pagePath,
  //     cssPage,
  //     jsPage,
  //     site,
  //     targetHost
  //   );
  //   await enssurePathExists(p.path);
  //   await ghWriteFile(`${p.path}.html`, p.html);
  // }
  const allPages = await Promise.all(
    pages.map((pagePath) =>
      getSinglePage(site, pagePath, cssPage, jsPage, site, targetHost)
    )
  );

  for (const p of allPages) {
    await enssurePathExists(p.path);
    await ghWriteFile(`${p.path}.html`, p.html);
  }

  console.log("🖼 Total processed images: ", PROCESSED_IMAGES.size);
  // console.log("Processed images: ", PROCESSED_IMAGES);
}

async function main() {
  const config = await init();

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
        const err = new RetryError(
          `${response.status}: Failed fetching page ${url} (${response.statusText})`
        );
        console.error(err);
        throw err;
      }

      const body = await response.text();

      return body;
    },
    RETRY_COUNT,
    RetryError
  );
}

async function fetchImage(imgUrl) {
  return await retry(
    async () => {
      const response = await retry(() => fetch(imgUrl), RETRY_COUNT, Error); // retry any fetch error

      if (!response.ok) {
        const err = new RetryError(
          `${response.status}: Failed fetching resource ${imgUrl} (${response.statusText})`
        );
        console.error(err);
        throw err;
      }

      const body = await response.buffer();

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

async function processImages(path, html) {
  let newHtml = html;

  // match all <img /> first
  const imgMatches = html.matchAll(
    new RegExp(
      // /<img\s[^>]*?src\s*=\s*['\"]([^'\"]*?)['\"][^>]*?data-sb-img-process[^>]*?\/>/
      // `<img\\s[^>]*?src\\s*=\\s*['\"]([^'\"]*?)['\"][^>]*?${ATTR.processImg}[^>]*?\\/>`,
      // /<img\s[^>]*?data-sb-img-process[^>]*?\/>/
      `<img\\s[^>]*?${ATTR.processImg}[^>]*?\\/>`,
      "gis"
    )
  );
  const relPath = getRelativePath(path);
  for (imgMatch of imgMatches) {
    // console.log("  🖼  img tag:", imgMatch[0]);

    const imgTag = imgMatch[0];
    // let newImgTag = imgTag;
    // match all resource links that end with ".ext"
    const allLinks = imgTag.matchAll(
      /https?:\/\/([\w\-\~]+(?:(?:\.[\w\-\~]+)+))([\w.,@?^=%&:\/~+#\-()\[\]!$*;{}\|]*\.[\w]+)/gis
    );
    for (link of allLinks) {
      const imgUrl = link[0];
      // get the path after the last '/'
      let imgPath = new RegExp(/\/([^\/]*)$/).exec(imgUrl)[1];
      // option with replacing all special symbols, but "decodeURI" preserves the original file name
      // imgPath = imgPath.replace(/[^\w\.-]/g, ""); // replce all non-alphanumeric characters

      if (!PROCESSED_IMAGES.has(link)) {
        // console.log("   - img url: ", imgUrl);
        // download image
        const imgSource = await fetchImage(imgUrl);
        // write image to file
        const imgFilePath = `${ASSETS_DIR_NAME}/${decodeURIComponent(imgPath)}`;
        await ghWriteFile(imgFilePath, imgSource);
      }

      // replace the image link in the whole page
      newHtml = newHtml.replaceAll(
        imgUrl,
        `${relPath}${ASSETS_DIR_NAME}/${imgPath}`
      );

      PROCESSED_IMAGES.add(imgUrl);
    }

    // replace the whole <img /> tag
    // newHtml = newHtml.replace(imgTag, newImgTag);
  }

  return newHtml;
}

async function purgeAndEmbedHTML(
  path,
  htmlCode,
  cssCode,
  jsCode,
  devHost,
  targetHost
) {
  // console.log("🔪 purgeAndEmbedHTML: ", path);
  // let text = prettier.format(html, { parser: "html" });
  let newHtml = await processImages(path, htmlCode);
  const purgeCSSResults = await new PurgeCSS().purge({
    content: [
      {
        raw: newHtml,
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
  newHtml = newHtml.replace(/<html /im, "\n<html ");

  const proxyCode = generateProxyCode(devHost, targetHost);
  // replace the CSS
  newHtml = newHtml.replace(
    CSS_REGEX,
    `<style>${purgeCSSResults[0].css}</style>${proxyCode}`
  );

  // no minimization
  // newHtml = newHtml.replace(CSS_REGEX, `<style>${cssCode}</style>`);

  // use as separate file
  // newHtml = newHtml.replace(CSS_REGEX, cssReplaceString(getRelativePath(path)));

  // replace the JS
  newHtml = newHtml.replace(JS_REGEX, jsReplaceString(getRelativePath(path)));
  // replace the JQuery
  newHtml = newHtml.replace(
    JQUERY_REGEX,
    jQueryReplaceString(getRelativePath(path))
  );
  return newHtml;
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

async function dirCleanup() {
  const contentDir = `${process.env.GITHUB_WORKSPACE}/${CONTENT_DIR_NAME}`;
  // create content dir if does not exist
  if (!(await pathExists(""))) {
    await fs.mkdir(contentDir);
  }
  const currentFiles = await fs.readdir(contentDir);
  currentFiles.forEach(async (fileName) => {
    // delete all files except STATIC_ASSETS_DIR_NAME folder
    if (STATIC_ASSETS_DIR_NAME != fileName) {
      await fs.rm(`${contentDir}/${fileName}`, {
        recursive: true,
        force: true,
      });
    }
  });
  if (!(await pathExists(`${contentDir}/${ASSETS_DIR_NAME}`))) {
    await fs.mkdir(`${contentDir}/${ASSETS_DIR_NAME}`);
  }

  // await fs.rm(`${process.env.GITHUB_WORKSPACE}/${CONTENT_DIR_NAME}`, {
  //   recursive: true,
  //   force: true,
  // });
  // await fs.mkdir(`${CONTENT_DIR_NAME}`);
  // await fs.mkdir(`${CONTENT_DIR_NAME}/${ASSETS_DIR_NAME}`);
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
