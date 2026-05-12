import { loadBridgeState, saveBridgeState } from './bridgeService';

const localKeys: Record<string, string> = {
  sessions: 'magi_sessions',
  memories: 'magi_memories',
  settings: 'magi_harness_settings_v2',
  documents: 'magi_harness_documents_v1',
};

const getLocalKey = (key: string) => localKeys[key] || `magi_${key}`;

export const loadLocalState = <T,>(key: string, fallback: T): T => {
  if (typeof localStorage === 'undefined') return fallback;

  try {
    const raw = localStorage.getItem(getLocalKey(key));
    return raw ? JSON.parse(raw) as T : fallback;
  } catch (error) {
    console.warn(`Failed to load local state ${key}`, error);
    return fallback;
  }
};

export const saveLocalState = (key: string, value: unknown) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(getLocalKey(key), JSON.stringify(value));
};

export const loadPersistentState = async <T,>(key: string, fallback: T): Promise<{ value: T; source: 'bridge' | 'local' }> => {
  try {
    const bridgeValue = await loadBridgeState<T>(key);
    if (bridgeValue !== null) {
      saveLocalState(key, bridgeValue);
      return {
        value: bridgeValue,
        source: 'bridge',
      };
    }
  } catch (error) {
    console.warn(`Bridge state unavailable for ${key}`, error);
  }

  return {
    value: loadLocalState(key, fallback),
    source: 'local',
  };
};

export const savePersistentState = async (key: string, value: unknown) => {
  saveLocalState(key, value);

  try {
    return await saveBridgeState(key, value);
  } catch (error) {
    console.warn(`Bridge state save failed for ${key}`, error);
    return null;
  }
};
