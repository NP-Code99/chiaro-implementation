export interface FormFieldMapping {
  selector: string
  value: string
  type: 'text' | 'email' | 'tel' | 'file' | 'select' | 'checkbox'
}

export interface ClaudeFormResponse {
  fields: FormFieldMapping[]
  submitSelector?: string
  reasoning?: string
}

export interface BrowserSession {
  url: string
  timeout?: number
}
