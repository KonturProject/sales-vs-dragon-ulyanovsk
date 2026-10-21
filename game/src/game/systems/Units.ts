/**
 * The Ulyanovsk game counts PAYMENTS (pieces), not money: the plan, the totals, the leaderboard and the strikes are
 * numbers of payments. Plain functions — shared by the game, the admin page and the group leaders' page.
 */

/** Russian plural form for `n`: plural(3, 'оплата', 'оплаты', 'оплат') -> 'оплаты'. */
export function pluralWord(n: number, one: string, few: string, many: string): string {
    const abs = Math.abs(Math.round(n));
    if (abs % 10 === 1 && abs % 100 !== 11) return one;
    if (abs % 10 >= 2 && abs % 10 <= 4 && (abs % 100 < 10 || abs % 100 >= 20)) return few;
    return many;
}

/** «1 оплата», «3 оплаты», «5 оплат». */
export function paymentsText(n: number): string {
    const count = Math.round(n);
    return `${count} ${pluralWord(count, 'оплата', 'оплаты', 'оплат')}`;
}
