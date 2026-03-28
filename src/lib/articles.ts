import fs from "node:fs";
import path from "node:path";
import { Marked, Renderer } from "marked";

const projectRoot = process.cwd();

const renderer = new Renderer();
renderer.heading = ({ tokens, depth }) => {
  const text = tokens.map((token) => ("raw" in token ? token.raw : "")).join("").trim();
  const slug = slugify(text);
  const innerHtml = marked.parser(tokens);
  return `<h${depth} id="${slug}">${innerHtml}</h${depth}>`;
};
renderer.code = ({ text, lang }) => {
  const language = (lang || "text").trim().toLowerCase();
  return [
    `<div class="code-block" data-language="${escapeHtml(language)}">`,
    `<div class="code-block-bar"><span>${escapeHtml(language)}</span></div>`,
    `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre>`,
    "</div>"
  ].join("");
};

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer
});

export type ArticleSection = "translations" | "posts";

export interface Article {
  slug: string;
  section: ArticleSection;
  url: string;
  title: string;
  summary: string;
  source?: string;
  date?: string;
  html: string;
  headings: Array<{ depth: number; text: string; slug: string }>;
  readingMinutes: number;
}

interface RawArticle {
  filePath: string;
  section: ArticleSection;
}

interface ParsedMarkdown {
  data: Record<string, string>;
  content: string;
}

const sectionConfig: Record<ArticleSection, { directory: string; label: string }> = {
  translations: {
    directory: "translations",
    label: "翻译"
  },
  posts: {
    directory: "content",
    label: "原创"
  }
};

function listMarkdownFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[>#*_~-]/g, "")
    .trim();
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

function extractSummary(content: string): string {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("---") && !line.startsWith("*原文来源"));

  return stripMarkdown(lines.join(" ")).slice(0, 140);
}

function parseLooseFrontmatter(rawContent: string): ParsedMarkdown {
  if (!rawContent.startsWith("---\n")) {
    return {
      data: {},
      content: rawContent
    };
  }

  const endIndex = rawContent.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return {
      data: {},
      content: rawContent
    };
  }

  const frontmatter = rawContent.slice(4, endIndex).trim();
  const content = rawContent.slice(endIndex + 5).trimStart();
  const data = frontmatter.split("\n").reduce<Record<string, string>>((accumulator, line) => {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      return accumulator;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");

    if (key) {
      accumulator[key] = value;
    }

    return accumulator;
  }, {});

  return { data, content };
}

function extractHeadings(tokens: ReturnType<typeof marked.lexer>) {
  return tokens
    .filter((token): token is { type: "heading"; depth: number; text: string } => token.type === "heading")
    .filter((token) => token.depth <= 3)
    .map((token) => ({
      depth: token.depth,
      text: token.text,
      slug: slugify(token.text)
    }));
}

function estimateReadingMinutes(content: string): number {
  const plainText = stripMarkdown(content);
  const charCount = plainText.replace(/\s+/g, "").length;
  return Math.max(1, Math.round(charCount / 320));
}

function resolveDate(data: Record<string, unknown>, filename: string): string | undefined {
  const candidate = typeof data.translated === "string"
    ? data.translated
    : typeof data.date === "string"
      ? data.date
      : undefined;

  if (candidate) {
    return candidate;
  }

  const match = filename.match(/(\d{4}-\d{2}(?:-\d{2})?)/);
  return match?.[1];
}

function parseArticle(raw: RawArticle): Article {
  const rawContent = fs.readFileSync(raw.filePath, "utf-8");
  const { data, content } = parseLooseFrontmatter(rawContent);
  const filename = path.basename(raw.filePath, ".md");
  const fallbackTitle = filename.replace(/^\d{4}-\d{2}(?:-\d{2})?-/, "").replace(/-/g, " ");
  const title = typeof data.title === "string" ? data.title : extractTitle(content, fallbackTitle);
  const tokens = marked.lexer(content);
  const headings = extractHeadings(tokens);
  const html = marked.parse(content) as string;

  return {
    slug: slugify(filename),
    section: raw.section,
    url: `/${raw.section}/${slugify(filename)}`,
    title,
    summary: typeof data.summary === "string" ? data.summary : extractSummary(content),
    source: typeof data.source === "string" ? data.source : undefined,
    date: resolveDate(data, filename),
    html,
    headings,
    readingMinutes: estimateReadingMinutes(content)
  };
}

export function getAllArticles(): Article[] {
  const raws: RawArticle[] = Object.entries(sectionConfig).flatMap(([section, config]) =>
    listMarkdownFiles(path.join(projectRoot, config.directory)).map((filePath) => ({
      filePath,
      section: section as ArticleSection
    }))
  );

  return raws
    .map(parseArticle)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

export function getFeaturedArticles(limit = 3): Article[] {
  return getAllArticles().slice(0, limit);
}

export function getArticleCounts() {
  const articles = getAllArticles();

  return {
    total: articles.length,
    translations: articles.filter((article) => article.section === "translations").length,
    posts: articles.filter((article) => article.section === "posts").length
  };
}

export function formatDate(value?: string): string {
  if (!value) {
    return "待补日期";
  }

  const match = value.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!match) {
    return value;
  }

  const [, year, month, day] = match;
  return day ? `${year} 年 ${Number(month)} 月 ${Number(day)} 日` : `${year} 年 ${Number(month)} 月`;
}

export function getArticle(section: string, slug: string): Article | undefined {
  return getAllArticles().find((article) => article.section === section && article.slug === slug);
}

export function getSectionLabel(section: ArticleSection): string {
  return sectionConfig[section].label;
}

export function getAdjacentArticles(target: Article) {
  const articles = getAllArticles();
  const index = articles.findIndex((article) => article.url === target.url);

  return {
    newer: index > 0 ? articles[index - 1] : undefined,
    older: index >= 0 && index < articles.length - 1 ? articles[index + 1] : undefined
  };
}

export function groupArticlesBySection() {
  const articles = getAllArticles();

  return {
    translations: articles.filter((article) => article.section === "translations"),
    posts: articles.filter((article) => article.section === "posts")
  };
}
