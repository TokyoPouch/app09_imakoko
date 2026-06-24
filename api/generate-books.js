import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/generate-books
// 環境変数: GEMINI_API_KEY
// 役割: 記録から「好きの棚」（人生テーマ棚＋本）を生成する
// v4.0: 棚=人生テーマ・動機、本=具体的な活動・関心 に再設計
// ============================================================

const MODELS_TO_TRY = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

// ── モデル試行ヘルパー ─────────────────────────────────────────
async function tryGenerateContent(ai, modelList, generateConfig) {
  let lastErr;
  for (const model of modelList) {
    try {
      console.log(`[generate-books] trying model: ${model}`);
      const response = await ai.models.generateContent({ model, ...generateConfig });
      console.log(`[generate-books] model OK: ${model}`);
      return { response, usedModel: model };
    } catch (err) {
      const errMsg = err.message || '';
      const isNotFound = /not found|404|invalid model|unknown model/i.test(errMsg);
      console.warn(`[generate-books] model "${model}" failed:`, errMsg);
      lastErr = err;
      if (isNotFound) continue;
      throw err;
    }
  }
  throw lastErr || new Error('All models failed');
}

// ── ローカルフォールバック用フィルター ───────────────────────────
const PROPER_NOUN_PATTERNS = [
  /^chatgpt$/i, /^gemini$/i, /^claude$/i, /^cursor$/i, /^copilot$/i,
  /^vercel$/i, /^openai$/i, /^midjourney$/i, /^dall-?e$/i,
  /^slack$/i, /^discord$/i, /^github$/i, /^figma$/i, /^notion$/i,
];

function isProperNounOnly(name) {
  return PROPER_NOUN_PATTERNS.some(p => p.test(name.trim()));
}

// ── ローカルフォールバック（本の生成） ───────────────────────────
// 記録のタグ・場所・メモキーワードから具体的な本名を抽出する
function buildLocalBooks(theme, relatedEntries) {
  const safeEntries = Array.isArray(relatedEntries) ? relatedEntries : [];

  // タグと場所から候補を収集
  const candidates = new Set();
  for (const r of safeEntries) {
    if (Array.isArray(r.tags)) {
      r.tags.filter(t => t && t.trim()).forEach(t => candidates.add(t.trim()));
    }
    if (r.location && r.location.trim()) {
      candidates.add(r.location.trim());
    }
  }

  if (candidates.size > 0) {
    return Array.from(candidates).slice(0, 5);
  }

  // テーマキーワードから抽出
  const themeText = (theme || '').toLowerCase();
  const DEFAULT_BOOK_MAP = [
    { keys: ['ai', '人工知能', '生成ai', 'web3'], books: ['AIとの対話', 'AIを使った制作', 'Webサービス開発'] },
    { keys: ['文化', '布', '伝統', '染め', '織'], books: ['日本の伝統布', 'ミャンマーパンツ', '手仕事の継承'] },
    { keys: ['認知症', '記憶', '介護'],           books: ['記憶のデザイン', 'ケアの記録'] },
    { keys: ['プログラミング', 'コード', '開発'],  books: ['アプリ制作', '技術の記録'] },
    { keys: ['音楽', 'ライブ', 'バンド'],          books: ['音楽との出会い', 'ライブの記憶'] },
    { keys: ['旅行', '旅', '異文化', '海外'],      books: ['旅で出会った風景', '文化交流'] },
    { keys: ['写真', 'カメラ', '撮影'],            books: ['撮影の記録', '家族写真'] },
  ];

  for (const group of DEFAULT_BOOK_MAP) {
    if (group.keys.some(k => themeText.includes(k))) {
      return group.books.slice(0, 3);
    }
  }

  // 最終フォールバック：テーマの単語を本名に
  const words = (theme || '').split(/[・、\s\/したい続けているを通して向き合]+/).filter(w => w.length > 1);
  return words.length > 0 ? words.slice(0, 3) : ['記録'];
}

// ── 複数テーマ用ローカルフォールバック ──────────────────────────
function buildLocalFullShelf(themes, entries) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  return (themes || []).map(theme => {
    // テーマに関連するエントリのみを渡す（全エントリを渡すと全棚に同じ本が入る）
    const themeWords = theme
      .split(/[・、\s\/したい続けているを通して向き合っている探求している]+/)
      .filter(w => w.length > 1)
      .map(w => w.toLowerCase());

    const relatedEntries = themeWords.length > 0
      ? safeEntries.filter(r => {
          const text = ((r.memo || '') + ' ' + (r.location || '') + ' ' + (r.futureMeAnswer || '')).toLowerCase();
          return themeWords.some(w => text.includes(w));
        })
      : [];

    const books = buildLocalBooks(theme, relatedEntries.length > 0 ? relatedEntries : safeEntries);
    return { title: theme, books };
  }).filter(s => s.title && s.books.length > 0);
}

// ============================================================
// HANDLER
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { theme = '', relatedEntries = [], themes, entries, userTags } = req.body || {};

  const apiKey = process.env.GEMINI_API_KEY;

  // ── 複数テーマ（新形式）: { themes, entries, userTags } ────────
  if (Array.isArray(themes) && themes.length > 0) {
    if (!apiKey) {
      console.warn('[generate-books] GEMINI_API_KEY not set → local fallback (multi-theme)');
      return res.status(200).json({ shelf: buildLocalFullShelf(themes, entries || []) });
    }

    const safeEntries = Array.isArray(entries) ? entries.slice(0, 50) : [];

    // memo・url・location・tags・futureMeAnswer をすべて渡す
    const entriesText = safeEntries
      .map(r => [
        `・${r.date || '?'}`,
        r.memo         ? `メモ:${r.memo}` : null,
        r.url          ? `URL:${r.url}` : null,
        r.location     ? `場所:${r.location}` : null,
        (r.tags && r.tags.length) ? `タグ:[${r.tags.join(',')}]` : null,
        r.futureMeAnswer ? `深掘り:${r.futureMeAnswer}` : null,
      ].filter(Boolean).join(' / '))
      .join('\n') || 'なし';

    const userTagsText = (userTags || []).join('、') || 'なし';
    const maxShelves = Math.min(themes.length + 1, 6);

    const userPromptMulti = `以下のJSONのみを返してください。
マークダウン（\`\`\`json 等の囲み）・前置き・説明文は一切禁止。

あなたはユーザーの記録から「好きの棚」を整理するAIです。
アプリのテーマ：「好きを忘れない。積み重なった自分と、もう一度つながる。」

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【棚 ＝ 人生テーマ・動機・価値観】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

棚名のルール：
1. 「写真」「音楽」「AI」「仕事」などの名詞カテゴリ名だけは禁止
2. 「〇〇したい」「〇〇を続けたい」「〇〇と向き合っている」など、ユーザーの内側の動機や意志が感じられる表現にする
3. 断定しすぎず、記録から自然に読み取れる範囲にする
4. 記録に根拠がない人生テーマは作らない
5. 参考テーマを元に記録を踏まえてより深い表現に書き換えてよい

悪い棚名：写真・カメラ / 音楽 / 仕事 / 認知症支援 / プログラミング・開発 / AI
良い棚名：写真を通して記憶を残したい / 文化を未来へ残したい / AIと人の関係を考え続けている / ものづくりを通して人とつながりたい / 忘れることと記憶を考え続けている

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【本 ＝ 具体的な関心・活動・記録のまとまり】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

本のルール：
1. 「〇〇の探索」「〇〇の旅」「〇〇の記録」などの汎用テンプレートは禁止
2. カテゴリ名だけにしない
3. 記録のメモ・URL・場所・タグ・深掘り回答にある具体的な言葉を使う
4. 記録に根拠がないものは作らない（事実を勝手に作らない）
5. 継続的な固有の活動名はそのまま使ってよい（例: ミャンマーパンツ、遠州刺し子、筑後織）
6. ツール名・サービス名のみは禁止（ChatGPT、Gemini、Vercel、Slack等）

悪い本名：写真の探索 / 音楽の探索 / AIとの探求 / このテーマの探索 / 記録のまとまり
良い本名：ミャンマーパンツ / 遠州刺し子 / Web3AIの学び / 家族写真 / 映画の記録 / Future Me

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【出力フォーマット】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "shelf": [
    { "title": "文化を未来へ残したい", "books": ["ミャンマーパンツ", "遠州刺し子"] },
    { "title": "AIと人の関係を考え続けている", "books": ["Web3AIの学び", "Future Me"] }
  ]
}

・棚: 最大${maxShelves}個
・本: 各棚5個以内
・重複禁止

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【参考テーマ（棚の方向性ヒント）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${JSON.stringify(themes)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【ユーザーのタグ一覧】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${userTagsText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【記録（メモ・URL・場所・タグ・深掘り回答を含む）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${entriesText}`;

    try {
      const ai = new GoogleGenAI({ apiKey });

      console.log('[generate-books] multi-theme request, themes:', themes.length, 'entries:', safeEntries.length);
      console.log('[generate-books] entries with location:', safeEntries.filter(r => r.location).length);
      console.log('[generate-books] entries with tags:', safeEntries.filter(r => r.tags && r.tags.length).length);
      console.log('[generate-books] entries with futureMeAnswer:', safeEntries.filter(r => r.futureMeAnswer).length);

      const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
        contents: userPromptMulti,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              shelf: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    books: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['title', 'books']
                }
              }
            },
            required: ['shelf']
          },
          maxOutputTokens: 1500,
          temperature: 0.5,
        },
      });

      console.log(`[generate-books] multi-theme response (${usedModel}):`, response.text);

      let raw = (response.text || '').trim();
      if (!raw) {
        try {
          const parts = response?.candidates?.[0]?.content?.parts;
          if (parts && parts.length > 0) raw = parts.map(p => p.text || '').join('').trim();
        } catch (e) {
          console.warn('[generate-books] candidates access failed:', e.message);
        }
      }
      if (!raw) throw new Error('Empty response from Gemini');

      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      const parsed = JSON.parse(raw);

      const shelf = Array.isArray(parsed.shelf)
        ? parsed.shelf
            .map(item => ({
              title: (item.title || '').trim(),
              books: Array.isArray(item.books)
                ? item.books.map(b => (b || '').trim()).filter(b => b && !isProperNounOnly(b)).slice(0, 5)
                : []
            }))
            .filter(s => s.title && s.books.length > 0)
        : [];

      if (shelf.length === 0) throw new Error('Empty shelf after filtering');

      console.log('[generate-books] multi-theme success, shelves:', shelf.length);
      console.log('[generate-books] shelf titles:', shelf.map(s => s.title));
      return res.status(200).json({ shelf });

    } catch (err) {
      console.warn('[generate-books] multi-theme API error → local fallback:', err.message || err);
      return res.status(200).json({ shelf: buildLocalFullShelf(themes, entries || []) });
    }
  }

  // ── 単一テーマ（旧形式）: { theme, relatedEntries } ───────────
  if (!apiKey) {
    console.error('[generate-books] GEMINI_API_KEY is not set → local fallback');
    const books = buildLocalBooks(theme, relatedEntries);
    return res.status(200).json({ books });
  }

  const safeEntries = Array.isArray(relatedEntries) ? relatedEntries.slice(0, 20) : [];
  const entriesText = safeEntries
    .map(r => [
      `・${r.date || '?'}`,
      r.memo     ? `メモ:${r.memo}` : null,
      r.url      ? `URL:${r.url}` : null,
      r.location ? `場所:${r.location}` : null,
      (r.tags && r.tags.length) ? `タグ:[${r.tags.join(',')}]` : null,
    ].filter(Boolean).join(' / '))
    .join('\n') || 'なし';

  const userPrompt = `以下のJSONのみを返してください。
マークダウン禁止・前置き禁止。

あなたは、ユーザーの記録から「関心テーマ（本）」を整理するAIです。

【本の命名ルール】
・「〇〇の探索」「〇〇の旅」などのテンプレートは禁止
・カテゴリ名だけにしない
・記録に根拠がある具体的な活動・関心名にする
・継続的な固有の活動名はOK（例: ミャンマーパンツ、遠州刺し子）
・ツール名・サービス名のみは禁止

【出力形式】
{"books": ["本1", "本2", "本3"]}

最大5個。

【人生テーマ（棚）】
${theme}

【記録】
${entriesText}`;

  try {
    const ai = new GoogleGenAI({ apiKey });

    const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
      contents: userPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: { books: { type: 'array', items: { type: 'string' } } },
          required: ['books']
        },
        maxOutputTokens: 400,
        temperature: 0.4,
      },
    });

    console.log(`[generate-books] single-theme response (${usedModel}):`, response.text);

    let effectiveRaw = (response.text || '').trim();
    if (!effectiveRaw) {
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (parts && parts.length > 0) effectiveRaw = parts.map(p => p.text || '').join('').trim();
      } catch (e) {
        console.warn('[generate-books] candidates access failed:', e.message);
      }
    }
    if (!effectiveRaw) throw new Error('Empty response from Gemini');

    effectiveRaw = effectiveRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(effectiveRaw);

    let books = [];
    if (Array.isArray(parsed.books)) {
      books = parsed.books
        .filter(b => typeof b === 'string' && b.trim())
        .map(b => b.trim())
        .filter(b => !isProperNounOnly(b))
        .slice(0, 5);
    }

    if (books.length === 0) books = buildLocalBooks(theme, relatedEntries);

    console.log('[generate-books] single-theme success, books:', books);
    return res.status(200).json({ books });

  } catch (err) {
    console.warn('[generate-books] API error → local fallback:', err.message || err);
    const books = buildLocalBooks(theme, relatedEntries);
    return res.status(200).json({ books });
  }
}
