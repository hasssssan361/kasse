// QR-Code / Link: Der Freischaltcode wird aus dem Freischalt-Link oder dem reinen Code herausgelesen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLicenseCode } from '../app/shared/core.js';

const CODE = 'eyJ2IjoxLCJkIjoiQUJDRCJ9.MH26vZhpDFcupx-PbmT_cj';

test('Freischaltcode aus QR-Inhalt, Link oder Text erkennen', () => {
  assert.equal(extractLicenseCode(`https://hasssssan361.github.io/kasse/kasse/#lizenz=${CODE}`), CODE);
  assert.equal(extractLicenseCode(`  ${CODE}\n`), CODE);
  assert.equal(extractLicenseCode(`https://x.example/app/?lizenz=${CODE}&a=1`), CODE);
  assert.equal(extractLicenseCode('https://example.com/irgendwas'), null);
  assert.equal(extractLicenseCode('Hallo Welt'), null);
  assert.equal(extractLicenseCode(''), null);
});
