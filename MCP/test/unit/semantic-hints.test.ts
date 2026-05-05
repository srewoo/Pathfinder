import { describe, it, expect } from 'vitest';
import { extractFieldLabels, extractButtonTexts } from '../../src/browser/playwright-adapter.js';

describe('extractFieldLabels', () => {
  it('given_type_into_field_description_when_extracted_then_returns_label', () => {
    expect(extractFieldLabels('Type "Sales Room" into the Room name field')).toContain('Room name');
  });

  it('given_fill_in_description_when_extracted_then_returns_label', () => {
    expect(extractFieldLabels('Fill in the Email field with test@example.com')).toContain('Email');
  });

  it('given_enter_in_box_when_extracted_then_returns_label', () => {
    expect(extractFieldLabels('Enter text in the Search box')).toContain('Search');
  });

  it('given_no_field_reference_when_extracted_then_returns_empty', () => {
    expect(extractFieldLabels('Click the Submit button')).toHaveLength(0);
  });

  it('given_quoted_field_name_when_extracted_then_returns_label', () => {
    const labels = extractFieldLabels('Type value into the "First Name" field');
    expect(labels.length).toBeGreaterThan(0);
  });
});

describe('extractButtonTexts', () => {
  it('given_click_button_description_when_extracted_then_returns_text', () => {
    expect(extractButtonTexts('Click the Create Room button')).toContain('Create Room');
  });

  it('given_press_btn_when_extracted_then_returns_text', () => {
    expect(extractButtonTexts('Press the Submit btn')).toContain('Submit');
  });

  it('given_click_quoted_when_extracted_then_returns_text', () => {
    expect(extractButtonTexts("Click 'Save Changes'")).toContain('Save Changes');
  });

  it('given_no_button_reference_when_extracted_then_returns_empty', () => {
    expect(extractButtonTexts('Type into the email field')).toHaveLength(0);
  });
});
