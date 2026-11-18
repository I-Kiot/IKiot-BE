import { classifyBankingInput } from './banking-input';

describe('classifyBankingInput', () => {
  it('treats a missing object as empty', () => {
    expect(classifyBankingInput(undefined)).toEqual({ kind: 'EMPTY' });
  });

  it('treats three blank or whitespace fields as empty', () => {
    expect(
      classifyBankingInput({
        accountNumber: '',
        bankName: '  ',
        accountName: null,
      }),
    ).toEqual({ kind: 'EMPTY' });
  });

  it('lists the missing fields when only some are filled', () => {
    expect(
      classifyBankingInput({
        accountNumber: '0123',
        bankName: '',
        accountName: ' ',
      }),
    ).toEqual({ kind: 'INCOMPLETE', missing: ['bankName', 'accountName'] });
  });

  it('returns trimmed values when all three are filled', () => {
    expect(
      classifyBankingInput({
        accountNumber: ' 0123 ',
        bankName: 'MB',
        accountName: 'NGUYEN VAN A ',
      }),
    ).toEqual({
      kind: 'COMPLETE',
      banking: {
        accountNumber: '0123',
        bankName: 'MB',
        accountName: 'NGUYEN VAN A',
      },
    });
  });
});
