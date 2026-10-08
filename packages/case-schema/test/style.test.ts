import { describe, expect, it } from 'vitest';
import { countSentences, findJudgingWords } from '../src/index';

describe('style', () => {
  it('finds judging words outside quotes only', () => {
    expect(findJudgingWords('A shocking and clearly brutal act.')).toEqual(['shocking', 'clearly', 'brutal']);
    expect(findJudgingWords('He called it “brutal.”')).toEqual([]);
    expect(findJudgingWords('The report was released.')).toEqual([]);
  });

  it('counts sentences without splitting on abbreviations', () => {
    expect(countSentences('Gov. Hochul signed the order on Oct. 1. The AG will investigate.')).toBe(2);
    expect(countSentences('One. Two. Three. Four. Five.')).toBe(5);
    expect(countSentences('The U.S. attorney declined. It was 3.5 miles away.')).toBe(2);
  });
});

describe('countSentences on news prose', () => {
  it('handles initialisms, initials, and lowercase abbreviations', () => {
    expect(countSentences('The U.S. attorney spoke on Monday. It was brief.')).toBe(2);
    expect(countSentences('Police in Ithaca, N.Y. said nothing more. The case remains open.')).toBe(2);
    expect(countSentences('Judge J. Smith ruled at 9 a.m. on Friday. The hearing ended.')).toBe(2);
    expect(countSentences('He met staff, e.g. the dean, at noon. Then he left.')).toBe(2);
    expect(countSentences('The vote was taken by Plan B. Then the board adjourned.')).toBe(2);
  });
});
