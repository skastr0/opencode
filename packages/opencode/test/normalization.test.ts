import { describe, expect, test } from "bun:test"

function snakeToCamel(str: string): string {
  return str.replace(/_+([a-z])/g, (_, char) => char.toUpperCase())
}

function normalizeInputParams(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    result[snakeToCamel(key)] = value
  }
  return result
}

describe("Normalization Logic", () => {
  test("snakeToCamel converts simple snake_case", () => {
    expect(snakeToCamel("file_path")).toBe("filePath")
    expect(snakeToCamel("old_string")).toBe("oldString")
    expect(snakeToCamel("very_long_variable_name")).toBe("veryLongVariableName")
  })

  test("snakeToCamel preserves camelCase", () => {
    expect(snakeToCamel("filePath")).toBe("filePath")
  })

  test("snakeToCamel edge cases", () => {
    // Leading underscore
    expect(snakeToCamel("_private")).toBe("Private")
    // Trailing underscore
    expect(snakeToCamel("trailing_")).toBe("trailing_")
    // Double underscore
    expect(snakeToCamel("double__underscore")).toBe("doubleUnderscore") // _u matches
    // Numbers
    expect(snakeToCamel("param_1")).toBe("param_1")
    // Mixed case in snake
    expect(snakeToCamel("param_Name")).toBe("param_Name")
  })

  test("normalizeInputParams handles object keys", () => {
    const input = {
      file_path: "/tmp/foo",
      old_string: "foo",
      is_valid: true,
    }
    const expected = {
      filePath: "/tmp/foo",
      oldString: "foo",
      isValid: true,
    }
    expect(normalizeInputParams(input)).toEqual(expected)
  })

  test("normalizeInputParams is shallow", () => {
    const input = {
      nested_obj: {
        inner_key: "value",
      },
    }
    const expected = {
      nestedObj: {
        inner_key: "value", // Shallow, so this remains snake_case
      },
    }
    expect(normalizeInputParams(input)).toEqual(expected)
  })
})
