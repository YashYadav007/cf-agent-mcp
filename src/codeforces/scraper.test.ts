import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProblemHtml } from './scraper.js';

test('extracts only problem content and preserves math and sample lines', () => {
  const html = `
    <nav>Navigation text</nav><script>secret()</script>
    <div class="problem-statement">
      <div class="header"><div class="title">A. Watermelon</div>
        <div class="time-limit">time limit per test 1 second</div>
        <div class="memory-limit">memory limit per test 64 megabytes</div></div>
      <div><p>Given <span class="tex-span">$n$</span>, print the answer.</p>
        <p>For <span class="tex-span">x_i</span>, use the rule.</p></div>
      <div class="input-specification"><div class="section-title">Input</div><p>Read one integer.</p></div>
      <div class="output-specification"><div class="section-title">Output</div><p>Print YES or NO.</p></div>
      <div class="sample-tests"><div class="sample-test">
        <div class="input"><div class="title">Input</div><pre>8<br/>2</pre></div>
        <div class="output"><div class="title">Output</div><pre>YES<br/>NO</pre></div>
      </div></div>
      <div class="note"><div class="section-title">Note</div><p>Any valid split works.</p></div>
    </div>`;
  const problem = parseProblemHtml(html, 4, 'A');
  assert.equal(problem.name, 'Watermelon');
  assert.equal(problem.timeLimit, '1 second');
  assert.equal(problem.memoryLimit, '64 megabytes');
  assert.match(problem.statement, /\$n\$/);
  assert.match(problem.statement, /\$x_i\$/);
  assert.doesNotMatch(problem.statement, /Navigation|secret|Read one integer/);
  assert.equal(problem.input, 'Read one integer.');
  assert.equal(problem.output, 'Print YES or NO.');
  assert.deepEqual(problem.examples, [{ input: '8\n2', output: 'YES\nNO' }]);
  assert.equal(problem.note, 'Any valid split works.');
});
