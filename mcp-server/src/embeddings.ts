/**
 * Embedding generation via Ollama
 *
 * Environment:
 *   OLLAMA_BASE_URL   - Ollama API URL (default: http://ollama:11434)
 *   EMBEDDING_MODEL   - Model name (default: nomic-embed-text)
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
const EMBEDDING_DIM = 768;

/**
 * Generate embedding vector for text
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    return Array(EMBEDDING_DIM).fill(0);
  }

  // Truncate long text
  const truncated = text.slice(0, 8000);

  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: truncated,
      }),
    });

    if (!resp.ok) {
      console.error(`Embedding error: ${resp.status} ${await resp.text()}`);
      return Array(EMBEDDING_DIM).fill(0);
    }

    const data = await resp.json();
    const embeddings = data.embeddings ?? data.embedding;

    if (Array.isArray(embeddings) && embeddings.length > 0) {
      // embeddings[0] for batch input, or embeddings itself for single
      return Array.isArray(embeddings[0]) ? embeddings[0] : embeddings;
    }

    return Array(EMBEDDING_DIM).fill(0);
  } catch (err) {
    console.error(`Embedding failed: ${err}`);
    return Array(EMBEDDING_DIM).fill(0);
  }
}

/**
 * Batch generate embeddings for multiple texts
 */
export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  // Ollama's embed endpoint handles batch, but we'll do sequentially for reliability
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await generateEmbedding(text));
    // Small delay to avoid overwhelming Ollama
    await new Promise((r) => setTimeout(r, 50));
  }
  return results;
}
