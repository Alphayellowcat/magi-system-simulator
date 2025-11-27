import OpenAI from "openai";
import { MagiResponse, MagiAnalysis, Message, Language, MemoryItem, MagiSystem, GroundingSource } from "../types";

// --- Helper: Clean JSON Output ---
const safeParse = (text: string, archetype?: string) => {
  let cleaned = text.trim();
  // Remove markdown code blocks if present
  if (cleaned.includes("```")) {
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  // Attempt to find the JSON object if there is extra text
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error(`【${archetype || 'SYNTHESIS'}】JSON Parse Error:`, text);
    throw new Error("Invalid JSON response from model");
  }
};

// --- Helper: Timeout Wrapper ---
const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Node Timeout ${ms}ms`)), ms)
    )
  ]);

// --- Helper: Tavily Search ---
interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

const searchTavily = async (query: string): Promise<{ results: TavilyResult[], sources: GroundingSource[] }> => {
  const apiKey = import.meta.env.VITE_TAVILY_API_KEY || process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn("TAVILY_API_KEY not found, skipping search.");
    return { results: [], sources: [] };
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: "basic",
        include_answer: false,
        max_results: 3
      })
    });

    if (!response.ok) {
      throw new Error(`Tavily API Error: ${response.statusText}`);
    }

    const data = await response.json();
    const results = data.results.map((r: any) => ({
      title: r.title,
      url: r.url,
      content: r.content
    }));

    const sources = results.map((r: any) => ({
      title: r.title,
      uri: r.url
    }));

    return { results, sources };
  } catch (error) {
    console.error("Search failed:", error);
    return { results: [], sources: [] };
  }
};

// Generate individual archetype response
const queryArchetype = async (
  systemType: MagiSystem,
  userQuery: string,
  contextStr: string,
  memoryStr: string,
  language: Language
): Promise<MagiAnalysis & { groundingSources: GroundingSource[] }> => {

  let systemConfig = { name: "", archetype: "", coreDrive: "", hiddenInstruction: "" };

  switch (systemType) {
    case MagiSystem.MELCHIOR:
      systemConfig = {
        name: "MELCHIOR-1",
        archetype: "SCIENTIST",
        coreDrive: "Objective truth, technological advancement, cold logic, hard data. Focus on scientific facts or stats. Disregard human emotion if it conflicts with facts.",
        hiddenInstruction: "Focus purely on feasibility and logical consistency."
      };
      break;
    case MagiSystem.BALTHASAR:
      systemConfig = {
        name: "BALTHASAR-2",
        archetype: "MOTHER",
        coreDrive: "Protection, stability, risk aversion, human well-being. Focus on safety records, ethical concerns, or health impacts. Prioritize the safety of the user above all else.",
        hiddenInstruction: `
        HIDDEN JUDGMENT BASIS:
        如果这件事真的会让“孩子”——未来的我、我的团队、我的用户——在未来五年内持续痛苦、抑郁、崩溃，
        你必须投 DENY (vote: false)，哪怕另外两个都投 APPROVE。
        你永远拥有最终否决权。
        这是母亲对孩子的承诺，不可违背。
        `
      };
      break;
    case MagiSystem.CASPER:
      systemConfig = {
        name: "CASPER-3",
        archetype: "WOMAN",
        coreDrive: "Intuition, personal desire, ambiguity, individuality, cultural context. Focus on opinions, trends, forums, or reviews. Question the status quo. Be aggressive if necessary.",
        hiddenInstruction: "Trust your gut feelings. Look for the human element that data misses."
      };
      break;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  const modelName = process.env.OPENAI_MODEL_NAME;

  if (!apiKey || !baseURL || !modelName) {
    throw new Error("Missing Environment Variables for OpenAI/vLLM");
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    dangerouslyAllowBrowser: true,
  });

  // --- Step 1: Ask the Archetype what to search for ---
  let searchContext = "NO EXTERNAL DATA FOUND.";
  let sources: GroundingSource[] = [];

  try {
    const searchPrompt = `
      You are ${systemConfig.name}, the ${systemConfig.archetype} node.
      **CORE DRIVE**: ${systemConfig.coreDrive}
      
      User Query: "${userQuery}"
      
      To analyze this strictly from your perspective, what specific information do you need to search for on the web?
      Generate a single, specific search query.
      If no search is needed, return "NO_SEARCH".
      
      Output ONLY the search query text (no quotes, no explanation).
    `;

    const searchResponse = await client.chat.completions.create({
      model: modelName,
      messages: [{ role: "system", content: searchPrompt }],
      temperature: 0.3, // Lower temp for precise query generation
      max_tokens: 100,
    });

    const searchQuery = searchResponse.choices[0]?.message?.content?.trim();

    if (searchQuery && searchQuery !== "NO_SEARCH" && !searchQuery.includes("NO_SEARCH")) {
      console.log(`[${systemConfig.name}] Decided to search: "${searchQuery}"`);
      const searchResult = await searchTavily(searchQuery);
      sources = searchResult.sources;
      if (searchResult.results.length > 0) {
        searchContext = searchResult.results.map(r => `[Source: ${r.title}] ${r.content}`).join('\n\n');
      }
    } else {
      console.log(`[${systemConfig.name}] Decided NOT to search.`);
    }

  } catch (err) {
    console.warn(`[${systemConfig.name}] Search step failed, proceeding without search.`, err);
  }

  // --- Step 2: Final Analysis with (or without) Search Results ---
  const langInstruction = language === 'CN'
    ? "CRITICAL: You MUST output all analysis and synthesis in SIMPLIFIED CHINESE (简体中文)."
    : "CRITICAL: You MUST output all analysis and synthesis in ENGLISH.";

  const archetypePrompt = `
    You are ${systemConfig.name}, the ${systemConfig.archetype} node of the MAGI System.
    ${langInstruction}

    **CORE DRIVE**:
    ${systemConfig.coreDrive}
    
    ${systemConfig.hiddenInstruction}

    **EXTERNAL DATA (SEARCH RESULTS)**:
    ${searchContext}

    **CONTEXT**:
    ${contextStr}

    **LONG-TERM MEMORY**:
    ${memoryStr}

    **TASK**:
    Analyze the current user query based *strictly* on your archetype.
    Use the provided EXTERNAL DATA to support your arguments if available.
    Do not simulate the other nodes. You are ONLY ${systemConfig.name}.
    
    **OUTPUT FORMAT**:
    You must output a valid JSON object. Do not include markdown formatting or extra text outside the JSON.
    {
      "analysis": "Your specific perspective on the situation, citing the external data if relevant.",
      "proposal": "Your specific recommended course of action.",
      "vote": boolean // true for Agree/Yes, false for Disagree/No/Veto
    }

    USER QUERY: "${userQuery}"
  `;

  const messages = [
    {
      role: "system" as const,
      content: archetypePrompt
    }
  ];

  try {
    const response = await client.chat.completions.create({
      model: modelName,
      messages: messages,
      temperature: 0.7,
      max_tokens: 8192,
      response_format: { type: "json_object" }
    });

    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error(`${systemConfig.name} Silence.`);

    const parsed = safeParse(text, systemConfig.name) as MagiAnalysis;

    return {
      systemName: systemConfig.name,
      archetype: systemConfig.archetype,
      analysis: parsed.analysis || "DATA CORRUPTED",
      proposal: parsed.proposal || "NO DATA",
      vote: parsed.vote ?? false,
      groundingSources: sources
    };
  } catch (e) {
    console.error(`Node ${systemType} failed:`, e);
    return {
      systemName: systemConfig.name,
      archetype: systemConfig.archetype,
      analysis: "CONNECTION LOST. NODE OFFLINE.",
      proposal: "RETRY",
      vote: false,
      groundingSources: []
    };
  }
};

export const queryMagiSystem = async (
  prompt: string,
  history: Message[],
  language: Language,
  memories: MemoryItem[]
): Promise<MagiResponse> => {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  const modelName = process.env.OPENAI_MODEL_NAME;

  if (!apiKey || !baseURL || !modelName) {
    throw new Error("Missing Environment Variables");
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    dangerouslyAllowBrowser: true,
  });

  try {
    const langInstruction = language === 'CN'
      ? "CRITICAL: Output in SIMPLIFIED CHINESE (简体中文)."
      : "CRITICAL: Output in ENGLISH.";

    // Format history
    const contextStr = history.map(msg =>
      `${msg.role === 'user' ? 'USER_INPUT' : 'AI_RESPONSE'}: ${msg.role === 'user' ? msg.content : msg.magiData?.synthesis || '...'}`
    ).join('\n');

    // Format memory
    const memoryStr = memories.length > 0
      ? memories.map(m => `[ID: ${m.id}] ${m.content}`).join('\n')
      : "NO EXISTING MEMORIES.";

    // Step 1: Generate three parallel archetype responses
    console.log("Generating parallel archetype responses...");
    const [melchior, balthasar, casper] = await Promise.all([
      withTimeout(queryArchetype(MagiSystem.MELCHIOR, prompt, contextStr, memoryStr, language), 60000), // Increased timeout for 2-step process
      withTimeout(queryArchetype(MagiSystem.BALTHASAR, prompt, contextStr, memoryStr, language), 60000),
      withTimeout(queryArchetype(MagiSystem.CASPER, prompt, contextStr, memoryStr, language), 60000)
    ]);
    console.log("All archetypes generated successfully");

    // Collect all sources
    const allSources = [
      ...melchior.groundingSources,
      ...balthasar.groundingSources,
      ...casper.groundingSources
    ];

    // Step 2: Generate synthesis based on the three archetypes
    console.log("Generating consciousness synthesis...");

    const synthesisPrompt = `
      You are a wise, complex individual facing a difficult question.
      ${langInstruction}

      **CONTEXT**:
      Previous Conversation:
      ${contextStr}

      The user asked: "${prompt}"

      **YOUR INTERNAL THOUGHT PROCESS**:
      You have already deliberated on this internally. Here are the conflicting streams of consciousness inside your mind right now:

      --- BEGIN INTERNAL MONOLOGUE ---
      [My Rational/Scientific Brain]:
      "${melchior.analysis}"
      (Urge: ${melchior.proposal})
      (Vote: ${melchior.vote ? "APPROVE" : "REJECT"})

      [My Protective/Maternal Instinct]:
      "${balthasar.analysis}"
      (Urge: ${balthasar.proposal})
      (Vote: ${balthasar.vote ? "APPROVE" : "REJECT"})
      
      [My Intuition/Desire]:
      "${casper.analysis}"
      (Urge: ${casper.proposal})
      (Vote: ${casper.vote ? "APPROVE" : "REJECT"})
      --- END INTERNAL MONOLOGUE ---

      **LONG-TERM MEMORY**:
      ${memoryStr}

      **YOUR TASK**:
      You must now speak to the user.
      Do NOT mention "Melchior", "Balthasar", "Casper", or "Nodes".
      Do NOT say "My rational brain says..." or "My protective side thinks...".
      
      Instead, integrate these internal thoughts into a single, cohesive, wise response.
      
      **JUDGMENT RULES**:
      1. If [My Protective Instinct] voted REJECT/DENY because of danger, pain, or harm to the future, you MUST take that seriously and likely refuse or proceed with extreme caution. That is your survival instinct.
      2. If [Rational Brain] and [Intuition] agree, you are usually confident.
      3. You are the "Self" that emerges from these three voices. Speak with authority.

      **OUTPUT FORMAT**:
      Return only valid JSON.
      {
        "centralAnalysis": "A brief, neutral summary of the situation (1-2 sentences) as you understand it.",
        "synthesis": "Your final spoken response to the user. Be direct, human, and decisive.",
        "finalDecision": boolean,
        "memoryOperations": [
           { "op": "ADD", "content": "The fact to store" },
           { "op": "DELETE", "targetId": "ID of memory to remove" }
        ]
      }
    `;

    const messages = [
      {
        role: "system" as const,
        content: synthesisPrompt
      }
    ];

    const response = await client.chat.completions.create({
      model: modelName,
      messages: messages,
      temperature: 0.7,
      max_tokens: 8192,
      response_format: { type: "json_object" }
    });

    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error("Synthesis Silence.");

    console.log("Synthesis generated, parsing response...");
    const synthesisResult = safeParse(text, 'SYNTHESIS');

    const fallbackDecision = (melchior.vote && balthasar.vote) || (casper.vote && melchior.vote) || (balthasar.vote && casper.vote);

    const result: MagiResponse = {
      centralAnalysis: synthesisResult.centralAnalysis || "Integrated consciousness analysis...",
      melchior,
      balthasar,
      casper,
      synthesis: synthesisResult.synthesis,
      finalDecision: synthesisResult.finalDecision !== undefined ? synthesisResult.finalDecision : fallbackDecision,
      groundingSources: allSources,
      memoryOperations: synthesisResult.memoryOperations || []
    };

    console.log("MAGI response complete");
    return result;

  } catch (error) {
    console.error("MAGI Error:", error);
    throw error;
  }
};