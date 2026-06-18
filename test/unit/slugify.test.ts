import { describe, expect, it } from 'vitest';
import { SlugFactory, slugify } from '../../webview/slugify';

describe('slugify', () => {
  it('converts basic text to lowercase with spaces as dashes', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('trims leading and trailing whitespace', () => {
    expect(slugify('  Hello World  ')).toBe('hello-world');
  });

  it('collapses multiple consecutive spaces into single dashes', () => {
    expect(slugify('Hello    World')).toBe('hello-world');
  });

  it('handles single-word input', () => {
    expect(slugify('Hello')).toBe('hello');
  });

  it('strips punctuation', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('preserves existing dashes in input', () => {
    expect(slugify('hello-world')).toBe('hello-world');
  });

  it('collapses consecutive dashes', () => {
    expect(slugify('hello---world')).toBe('hello-world');
  });

  it('handles mixed case with punctuation and spaces', () => {
    expect(slugify('The Quick Brown Fox!')).toBe('the-quick-brown-fox');
  });

  it('strips leading/trailing dashes', () => {
    expect(slugify('-hello-world-')).toBe('hello-world');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('handles whitespace-only string', () => {
    expect(slugify('   ')).toBe('');
  });

  it('handles text with numbers', () => {
    expect(slugify('Chapter 1: Introduction')).toBe('chapter-1-introduction');
  });

  it('strips special characters while preserving alphanumerics and dashes', () => {
    expect(slugify('Hello@#$%World')).toBe('helloworld');
  });

  it('handles underscores (treated as part of word characters)', () => {
    expect(slugify('hello_world')).toBe('hello_world');
  });

  it('handles mixed whitespace and punctuation', () => {
    expect(slugify('  Hello,  World!  ')).toBe('hello-world');
  });

  it('handles single dash as input', () => {
    expect(slugify('-')).toBe('');
  });

  it('handles multiple dashes with spaces', () => {
    expect(slugify('hello - - world')).toBe('hello-world');
  });

  it('handles parentheses', () => {
    expect(slugify('Function (deprecated)')).toBe('function-deprecated');
  });

  it('handles brackets', () => {
    expect(slugify('Array [index]')).toBe('array-index');
  });

  it('handles curly braces', () => {
    expect(slugify('Object {key}')).toBe('object-key');
  });

  it('handles slashes and backslashes', () => {
    expect(slugify('path/to/file')).toBe('pathtofile');
  });

  it('handles ampersands and other symbols', () => {
    expect(slugify('A & B')).toBe('a-b');
  });

  it('handles emoji-like sequences (unicode)', () => {
    // Emoji and special unicode chars are stripped
    expect(slugify('Hello 👋 World')).toBe('hello-world');
  });

  it('handles accented characters', () => {
    // Accented characters (é, ñ, etc.) are typically stripped by [^\w-]
    // (depends on locale; with default en-US, these are non-word)
    expect(slugify('Café')).toBe('caf');
  });

  it('idempotent: slugify(slugify(x)) === slugify(x)', () => {
    const text = 'Hello, World!';
    const slug1 = slugify(text);
    const slug2 = slugify(slug1);
    expect(slug1).toBe(slug2);
  });
});

describe('SlugFactory', () => {
  it('generates slugs for unique inputs', () => {
    const factory = new SlugFactory();
    expect(factory.slug('Hello World')).toBe('hello-world');
    expect(factory.slug('Goodbye Moon')).toBe('goodbye-moon');
  });

  it('suffixes duplicates with -1, -2, etc.', () => {
    const factory = new SlugFactory();
    expect(factory.slug('Hello')).toBe('hello');
    expect(factory.slug('Hello')).toBe('hello-1');
    expect(factory.slug('Hello')).toBe('hello-2');
  });

  it('handles case-insensitive duplicates', () => {
    const factory = new SlugFactory();
    expect(factory.slug('Hello')).toBe('hello');
    expect(factory.slug('HELLO')).toBe('hello-1');
    expect(factory.slug('hELLo')).toBe('hello-2');
  });

  it('handles punctuation-normalized duplicates', () => {
    const factory = new SlugFactory();
    expect(factory.slug('Hello, World')).toBe('hello-world');
    expect(factory.slug('Hello, World!')).toBe('hello-world-1');
  });

  it('treats whitespace variants as duplicates', () => {
    const factory = new SlugFactory();
    expect(factory.slug('Hello World')).toBe('hello-world');
    expect(factory.slug('Hello    World')).toBe('hello-world-1');
  });

  it('maintains independent counters per slug base', () => {
    const factory = new SlugFactory();
    expect(factory.slug('Alpha')).toBe('alpha');
    expect(factory.slug('Beta')).toBe('beta');
    expect(factory.slug('Alpha')).toBe('alpha-1');
    expect(factory.slug('Beta')).toBe('beta-1');
    expect(factory.slug('Alpha')).toBe('alpha-2');
    expect(factory.slug('Beta')).toBe('beta-2');
  });

  it('each factory instance is independent', () => {
    const factory1 = new SlugFactory();
    const factory2 = new SlugFactory();

    expect(factory1.slug('Hello')).toBe('hello');
    expect(factory1.slug('Hello')).toBe('hello-1');

    expect(factory2.slug('Hello')).toBe('hello');
    expect(factory2.slug('Hello')).toBe('hello-1');
  });

  it('handles empty string', () => {
    const factory = new SlugFactory();
    expect(factory.slug('')).toBe('');
    expect(factory.slug('')).toBe('-1');
  });

  it('handles whitespace-only strings', () => {
    const factory = new SlugFactory();
    expect(factory.slug('   ')).toBe('');
    expect(factory.slug('   ')).toBe('-1');
  });

  it('realistic heading sequence', () => {
    const factory = new SlugFactory();
    expect(factory.slug('Introduction')).toBe('introduction');
    expect(factory.slug('API Reference')).toBe('api-reference');
    expect(factory.slug('Getting Started')).toBe('getting-started');
    expect(factory.slug('Introduction')).toBe('introduction-1');
    expect(factory.slug('API Reference')).toBe('api-reference-1');
  });

  it('handles many duplicates', () => {
    const factory = new SlugFactory();
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(factory.slug('Section'));
    }
    expect(results).toEqual(['section', 'section-1', 'section-2', 'section-3', 'section-4']);
  });

  it('reset() clears dedup state so ids are stable across passes', () => {
    const factory = new SlugFactory();
    expect(factory.slug('Section One')).toBe('section-one');
    expect(factory.slug('Section Two')).toBe('section-two');
    // Without reset, a second pass would re-suffix every slug.
    factory.reset();
    expect(factory.slug('Section One')).toBe('section-one');
    expect(factory.slug('Section Two')).toBe('section-two');
  });
});
