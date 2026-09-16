export type DepositFormLabels = {
  channel: string;
  purpose: string;
  sourceOfFunds: string;
};

export function resolveDepositFormLabels(input: DepositFormLabels): DepositFormLabels {
  const channel = input.channel.trim();
  const source = input.sourceOfFunds.trim();
  // Confirmed Sandbox label migrations; selection still requires an exact live option.
  return {
    channel: channel === '电汇' ? 'SWIFT' : channel,
    purpose: input.purpose.trim(),
    sourceOfFunds: source === '工资' ? '工资及薪酬收入' : source
  };
}
