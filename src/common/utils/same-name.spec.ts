import { isSameName } from './same-name';

describe('same-name', () => {
  it('ignores case, including accented letters', () => {
    expect(isSameName('Bàn', 'bÀN')).toBe(true);
    expect(isSameName('CN Hà Nội', 'cn hà nội')).toBe(true);
  });

  it('ignores spaces at both ends but not inside the name', () => {
    expect(isSameName('  Tủ ', 'Tủ')).toBe(true);
    expect(isSameName('Tủ áo', 'Tủáo')).toBe(false);
  });

  it('treats composed and decomposed accents as the same letter', () => {
    const composed = 'Ghế';
    const decomposed = 'Ghế';
    expect(composed).not.toBe(decomposed);
    expect(isSameName(composed, decomposed)).toBe(true);
  });

  it('keeps different names apart', () => {
    expect(isSameName('Bàn', 'Ghế')).toBe(false);
    expect(isSameName('Bàn', 'Ban')).toBe(false);
  });
});
