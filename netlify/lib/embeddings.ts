/**
 * SAM EMBEDDINGS — semantic recall infrastructure
 *
 * Uses OpenAI text-embedding-3-small (1536 dims, $0.02/1M tokens).
 * Each user prompt gets embedded on persistence; at query time we cosine
 * against the embedding store to find the top-K most semantically relevant
 * past turns, then inject those alongside the recent literal history.
 *
 * Why text-embedding-3-small vs ada-002 or 3-large:
 *   - 3-small is 5x cheaper than ada-002 with better quality
 *   - 3-large is 6.5x more expensive than 3-small for marginal gain on a
 *     personal corpus (under 10K documents)
 *   - 1536 dims × 4 bytes/float = 6 KB per turn — fits comfortably under
 *     the 5 MB Netlify Blob limit even at 800+ turns
 */

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

export interface TurnEmbedding {
  at: string;          // ISO timestamp matching the user turn in sam-chat-history
  embedding: number[]; // 1536 floats
}

/**
 * Embed a single piece of text. Returns the vector.
 * Best-effort — returns null on any failure rather than throwing, so caller
 * can decide whether to skip persistence vs hard-fail.
 */
export async function embedText(text: string, openaiKey: string): Promise<number[] | null> {
  if (!text || !openaiKey) return null;
  // Truncate to ~6K chars to stay under model context (8191 tokens)
  const truncated = text.length > 6000 ? text.substring(0, 6000) : text;
  try {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: truncated,
      }),
    });
    if (!r.ok) {
      console.error(`[embeddings] OpenAI returned ${r.status}: ${(await r.text()).substring(0, 200)}`);
      return null;
    }
    const data = await r.json();
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) return null;
    return vec;
  } catch (e: any) {
    console.error(`[embeddings] embed call failed: ${e?.message || e}`);
    return null;
  }
}

/**
 * Cosine similarity between two equal-length vectors. Returns a value in [-1, 1].
 * 1 = identical direction, 0 = orthogonal, -1 = opposite.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find the top-K most similar embeddings to a query. Returns sorted by score
 * descending. Each result includes the original `at` (ISO timestamp) plus its
 * similarity score, so the caller can match back to the source turn.
 */
export function topKSimilar(
  queryEmbedding: number[],
  corpus: TurnEmbedding[],
  k: number,
  minScore = 0.3
): Array<{ at: string; score: number }> {
  if (!corpus || corpus.length === 0) return [];
  const scored = corpus.map((te) => ({
    at: te.at,
    score: cosineSimilarity(queryEmbedding, te.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score >= minScore).slice(0, k);
}
