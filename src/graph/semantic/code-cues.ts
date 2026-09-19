import ts from 'typescript';
import type { CodeDocument } from './types.js';
const words = (text: string): string => text.replace(/([A-Z]+)([A-Z][a-z])/g,'$1 $2')
  .replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_$]+/g,' ').trim();
export function codeCues(document: CodeDocument): string {
  if (document.mode === 'metadata') return document.text;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest,false,ts.LanguageVariant.Standard,
    document.text.split('\n').slice(3).join('\n'));
  const comments: string[] = [], identifiers: string[] = [], messages: string[] = [];
  let token: ts.SyntaxKind;
  while ((token=scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    const text=scanner.getTokenText();
    if (token===ts.SyntaxKind.SingleLineCommentTrivia||token===ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push(text.replace(/^\/\/?\*?|\*\/$/g,'').replace(/^\s*\*\s?/gm,'').trim());
    } else if (token===ts.SyntaxKind.Identifier) identifiers.push(words(text));
    else if ([ts.SyntaxKind.StringLiteral,ts.SyntaxKind.NoSubstitutionTemplateLiteral,ts.SyntaxKind.TemplateHead,
      ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail].includes(token)) messages.push(scanner.getTokenValue());
  }
  return [`Function: ${words(document.node.name)}`,`Comments: ${[...new Set(comments)].join('\n')}`,
    `Names: ${[...new Set(identifiers)].join(' ')}`,`Messages: ${[...new Set(messages)].join('\n')}`].join('\n');
}
