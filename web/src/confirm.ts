interface ConfirmWriteOptions {
  /** Target address (block number for CLASSIC, page number for ULTRALIGHT). */
  block: number;
  data: string;
  key: string;
  /** Address unit label; defaults to 'block'. */
  unit?: 'block' | 'page';
}

export async function confirmWrite(opts: ConfirmWriteOptions): Promise<boolean> {
  const unit = opts.unit ?? 'block';
  const hexLen = opts.data.length;
  return new Promise<boolean>((resolve) => {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
    `;

    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('data-testid', 'write-confirm-modal');
    modal.style.cssText = `
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 16px; padding: 24px; max-width: 480px; width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,.4);
    `;

    function onKeyDown(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close(false);
      }
    }

    function close(result: boolean): void {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(result);
    }

    function renderStep1(): void {
      modal.replaceChildren();
      modal.setAttribute('data-step', '1');

      const title = document.createElement('h2');
      title.style.cssText = 'margin: 0 0 12px; color: var(--danger); font-size: 18px;';
      title.textContent = 'Confirm Write — Step 1 of 2';

      const info = document.createElement('div');
      info.style.cssText = 'margin-bottom: 16px; font-size: 14px; line-height: 1.6;';

      const blockLine = document.createElement('p');
      blockLine.style.cssText = 'margin: 0 0 8px;';
      const blockLabel = document.createElement('strong');
      blockLabel.textContent = `Target ${unit}:`;
      blockLine.appendChild(blockLabel);
      blockLine.append(` ${opts.block}`);

      const dataLabel = document.createElement('p');
      dataLabel.style.cssText = 'margin: 0 0 8px;';
      const dataLabelStrong = document.createElement('strong');
      dataLabelStrong.textContent = `Data (${hexLen} hex):`;
      dataLabel.appendChild(dataLabelStrong);

      const dataCode = document.createElement('code');
      dataCode.style.cssText = 'display:block; padding: 8px; background: var(--input); border-radius: 8px; font-size: 13px; word-break: break-all;';
      dataCode.textContent = opts.data;

      const warning = document.createElement('p');
      warning.style.cssText = 'margin: 12px 0 0; color: var(--danger); font-weight: 600;';
      warning.textContent = `⚠ This will permanently overwrite ${unit} ${opts.block}. This cannot be undone.`;

      info.appendChild(blockLine);
      info.appendChild(dataLabel);
      info.appendChild(dataCode);
      info.appendChild(warning);

      const ackLabel = document.createElement('label');
      ackLabel.style.cssText = 'display: flex; align-items: flex-start; gap: 10px; cursor: pointer; margin-bottom: 20px; font-size: 14px;';

      const ackCheckbox = document.createElement('input');
      ackCheckbox.type = 'checkbox';
      ackCheckbox.setAttribute('data-testid', 'confirm-ack');
      ackCheckbox.style.cssText = 'margin-top: 2px; width: auto; flex-shrink: 0;';

      const ackText = document.createElement('span');
      ackText.textContent = `I understand this overwrites ${unit} ${opts.block}`;

      ackLabel.appendChild(ackCheckbox);
      ackLabel.appendChild(ackText);

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

      const cancelBtn = document.createElement('button');
      cancelBtn.setAttribute('data-testid', 'confirm-cancel');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'padding: 10px 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--input); color: var(--text); cursor: pointer; font-weight: 600;';
      cancelBtn.addEventListener('click', () => close(false));

      const continueBtn = document.createElement('button');
      continueBtn.setAttribute('data-testid', 'confirm-step1');
      continueBtn.textContent = 'Continue →';
      continueBtn.disabled = true;
      continueBtn.style.cssText = 'padding: 10px 16px; border-radius: 10px; border: none; background: var(--accent); color: white; cursor: pointer; font-weight: 600;';
      continueBtn.addEventListener('click', () => renderStep2());

      ackCheckbox.addEventListener('change', () => {
        continueBtn.disabled = !ackCheckbox.checked;
      });

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(continueBtn);

      modal.appendChild(title);
      modal.appendChild(info);
      modal.appendChild(ackLabel);
      modal.appendChild(btnRow);
    }

    function renderStep2(): void {
      modal.replaceChildren();
      modal.setAttribute('data-step', '2');

      const container = document.createElement('div');
      container.setAttribute('data-testid', 'write-confirm-step2');

      const title = document.createElement('h2');
      title.style.cssText = 'margin: 0 0 12px; color: var(--danger); font-size: 18px;';
      title.textContent = 'Confirm Write — Step 2 of 2';

      const instruction = document.createElement('p');
      instruction.style.cssText = 'margin: 0 0 16px; font-size: 14px;';
      instruction.append('Type ');
      const blockStrong = document.createElement('strong');
      blockStrong.textContent = String(opts.block);
      instruction.appendChild(blockStrong);
      instruction.append(' in the box below to confirm:');

      const typeInput = document.createElement('input');
      typeInput.setAttribute('data-testid', 'confirm-type');
      typeInput.type = 'text';
      typeInput.setAttribute('autocomplete', 'off');
      typeInput.placeholder = String(opts.block);
      typeInput.style.cssText = 'width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--input); color: var(--text); font: inherit; margin-bottom: 20px;';

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

      const cancelBtn = document.createElement('button');
      cancelBtn.setAttribute('data-testid', 'confirm-cancel');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'padding: 10px 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--input); color: var(--text); cursor: pointer; font-weight: 600;';
      cancelBtn.addEventListener('click', () => close(false));

      const writeBtn = document.createElement('button');
      writeBtn.setAttribute('data-testid', 'confirm-step2');
      writeBtn.textContent = 'Write Now';
      writeBtn.disabled = true;
      writeBtn.style.cssText = 'padding: 10px 16px; border-radius: 10px; border: none; background: var(--danger); color: white; cursor: pointer; font-weight: 600;';
      writeBtn.addEventListener('click', () => close(true));

      typeInput.addEventListener('input', () => {
        writeBtn.disabled = typeInput.value !== String(opts.block);
      });

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(writeBtn);

      container.appendChild(title);
      container.appendChild(instruction);
      container.appendChild(typeInput);
      container.appendChild(btnRow);
      modal.appendChild(container);
    }

    renderStep1();
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
  });
}
