export interface Chunk {
  index: number;
  content: string;
  startChar: number;
  endChar: number;
  /** The section heading this chunk belongs to (for context during retrieval) */
  parentHeading?: string;
}

const TARGET_CHUNK_CHARS = 3000;
const OVERLAP_CHARS = 300;
const MIN_CHUNK_CHARS = 200;
const DEDUP_THRESHOLD = 0.8;

export function chunkText(text: string, _url: string): Chunk[] {
  if (!text || text.trim().length === 0) return [];

  const sections = splitBySections(text);

  let chunks: Chunk[];
  if (sections.length > 1) {
    chunks = chunkSections(sections);
  } else {
    chunks = chunkByCharacters(text);
  }

  chunks = mergeSmallChunks(chunks);
  chunks = deduplicateChunks(chunks);

  return chunks.map((c, i) => ({ ...c, index: i }));
}

interface Section {
  text: string;
  heading?: string;
}

function splitBySections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let current: string[] = [];
  let currentHeading: string | undefined;

  for (const line of lines) {
    // Navigation markers are structural separators — skip them from chunk content
    // since the crawler already captures links separately.
    if (line.startsWith('[Navigation:')) continue;

    const isHeading = line.startsWith('## ');
    const isTopicBreak =
      isHeading ||
      (line.startsWith('```') && current.length > 10);

    if (isTopicBreak && current.length > 0) {
      const sectionText = current.join('\n').trim();
      if (sectionText.length > 50) {
        sections.push({ text: sectionText, heading: currentHeading });
      }
      current = [line];
      if (isHeading) {
        currentHeading = line.replace(/^#+\s*/, '').trim();
      }
    } else {
      if (isHeading) {
        currentHeading = line.replace(/^#+\s*/, '').trim();
      }
      current.push(line);
    }
  }

  const last = current.join('\n').trim();
  if (last.length > 50) {
    sections.push({ text: last, heading: currentHeading });
  }

  return sections;
}

function chunkSections(sections: Section[]): Chunk[] {
  const chunks: Chunk[] = [];
  let charOffset = 0;
  let index = 0;

  for (const section of sections) {
    const heading = section.heading;

    if (section.text.length <= TARGET_CHUNK_CHARS) {
      const content = heading && !section.text.startsWith(`## ${heading}`)
        ? `[Section: ${heading}]\n${section.text.trim()}`
        : section.text.trim();
      chunks.push({
        index: index++,
        content,
        startChar: charOffset,
        endChar: charOffset + section.text.length,
        parentHeading: heading,
      });
    } else {
      const subChunks = chunkByCharacters(section.text);
      subChunks.forEach((c) => {
        const content = heading && c.startChar > 0
          ? `[Section: ${heading}]\n${c.content}`
          : c.content;
        chunks.push({
          ...c,
          index: index++,
          content,
          startChar: charOffset + c.startChar,
          endChar: charOffset + c.endChar,
          parentHeading: heading,
        });
      });
    }
    charOffset += section.text.length + 1;
  }

  return chunks;
}

function chunkByCharacters(text: string): Chunk[] {
  if (text.length <= TARGET_CHUNK_CHARS) {
    return [{ index: 0, content: text.trim(), startChar: 0, endChar: text.length }];
  }

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    let end = Math.min(start + TARGET_CHUNK_CHARS, text.length);

    if (end < text.length) {
      const breakPoint = findBreakPoint(text, end);
      if (breakPoint > start) end = breakPoint;
    }

    const content = text.slice(start, end).trim();
    if (content.length > 0) {
      chunks.push({ index: index++, content, startChar: start, endChar: end });
    }

    start = Math.max(start + 1, end - OVERLAP_CHARS);
  }

  return chunks;
}

function findBreakPoint(text: string, near: number): number {
  const paragraphBreak = text.lastIndexOf('\n\n', near);
  if (paragraphBreak > near - 500) return paragraphBreak;

  const lineBreak = text.lastIndexOf('\n', near);
  if (lineBreak > near - 200) return lineBreak;

  const sentenceBreak = text.lastIndexOf('. ', near);
  if (sentenceBreak > near - 100) return sentenceBreak + 1;

  const spaceBreak = text.lastIndexOf(' ', near);
  if (spaceBreak > near - 50) return spaceBreak;

  return near;
}

function mergeSmallChunks(chunks: Chunk[]): Chunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: Chunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.content.length >= MIN_CHUNK_CHARS) {
      merged.push(chunk);
      continue;
    }

    // Merge small chunk with the previous chunk if possible
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.content.length + chunk.content.length <= TARGET_CHUNK_CHARS + 500) {
        prev.content = prev.content + '\n\n' + chunk.content;
        prev.endChar = chunk.endChar;
        continue;
      }
    }

    // Otherwise merge with next chunk
    if (i + 1 < chunks.length) {
      const next = chunks[i + 1];
      next.content = chunk.content + '\n\n' + next.content;
      next.startChar = chunk.startChar;
      if (chunk.parentHeading && !next.parentHeading) {
        next.parentHeading = chunk.parentHeading;
      }
      continue;
    }

    merged.push(chunk);
  }

  return merged;
}

function deduplicateChunks(chunks: Chunk[]): Chunk[] {
  if (chunks.length <= 1) return chunks;

  const result: Chunk[] = [];

  for (const chunk of chunks) {
    const isDuplicate = result.some((existing) => {
      return jaccardSimilarity(existing.content, chunk.content) >= DEDUP_THRESHOLD;
    });
    if (!isDuplicate) {
      result.push(chunk);
    }
  }

  return result;
}

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  return intersection / (wordsA.size + wordsB.size - intersection);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
