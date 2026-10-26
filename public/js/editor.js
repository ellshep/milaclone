// TipTap rich-text editor for note and comment cards. This file is the esbuild
// entry: server.js bundles it (and TipTap) into public/vendor/editor.js at boot,
// and cards load that bundle with import() the first time a card is edited.
// StarterKit brings bold/italic/strike/code, headings, lists, quotes, code
// blocks, links and the markdown input rules (**x**, # , - , > , ```).

import { Editor, getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';

const extensions = placeholder => [
  StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
  Highlight,
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder }),
];
const schema = getSchema(extensions(''));

// Mounts an editor in `element` (emptied first). onChange(doc, text) fires on
// every edit with the TipTap JSON and its plain text. Throws, before touching
// the element, on a doc the schema can't hold: TipTap would otherwise swap in an
// empty doc and the next keystroke would save over the real content.
export function mountEditor(element, doc, { placeholder = '', onChange } = {}) {
  if (doc) schema.nodeFromJSON(doc).check();
  element.replaceChildren();
  return new Editor({
    element,
    content: doc || '',
    extensions: extensions(placeholder),
    onUpdate: ({ editor }) => onChange?.(editor.getJSON(), editor.getText({ blockSeparator: '\n' }).trim()),
  });
}
