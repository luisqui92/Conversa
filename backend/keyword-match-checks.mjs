import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesKeyword } from './keyword-match.mjs';
test('Palabras completas, frases, acentos y puntuación sin coincidencias parciales', () => {
  for (const [text, term, expected] of [
    ['casamiento', 'casa', false],
    ['preciosa', 'precio', false],
    ['casas', 'casa', false],
    ['CASA, ¿cuál es el precio?', 'casa', true],
    ['Quiero información.', 'informacion', true],
    ['Precio de casa', 'precio casa', false],
    ['Precio: casa', 'precio casa', true],
    ['Un 1234', '123', false],
    ['Я хочу дом', 'дом', true],
    ['domicilio', 'dom', false],
    ['', 'casa', false],
    ['Hola', '', false],
    ['Otro precio.', 'precio', true],
  ])
    assert.equal(matchesKeyword(text, term), expected, `${term}: ${text}`);
});
