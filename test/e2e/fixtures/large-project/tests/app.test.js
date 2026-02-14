import { add, subtract } from '../src/utils';

test('add function', () => {
  expect(add(2, 3)).toBe(5);
});

test('subtract function', () => {
  expect(subtract(5, 3)).toBe(2);
});
