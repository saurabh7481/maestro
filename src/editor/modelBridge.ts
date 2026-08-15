export interface EditorTextModel {
  getValue: () => string;
  getValueLength: () => number;
  setValue: (value: string) => void;
  isDisposed: () => boolean;
  onDidChangeContent: (listener: () => void) => { dispose: () => void };
}

interface EditorModelApi {
  get: (tabId: string) => EditorTextModel | undefined;
  dispose: (tabId: string) => void;
  didSave: (tabId: string) => void;
}

let api: EditorModelApi | null = null;

export function registerEditorModelApi(next: EditorModelApi) {
  api = next;
}

export function getEditorModel(tabId: string): EditorTextModel | undefined {
  return api?.get(tabId);
}

export function disposeEditorModel(tabId: string) {
  api?.dispose(tabId);
}

export function notifyEditorModelSaved(tabId: string) {
  api?.didSave(tabId);
}
