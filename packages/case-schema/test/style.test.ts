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
