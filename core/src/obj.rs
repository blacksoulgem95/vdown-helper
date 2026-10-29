//! JavaScript object semantics over `serde_json::Value`, for the functions that take and return the extension's records
//! (resources, jobs) whole: unknown fields pass through untouched, as with `{ ...a, ...b }`.
//!
//! The TypeScript types never hold `null`, so `null` stands for `undefined`: a property set to `undefined` arrives as
//! `null` from the wasm boundary, overrides like `undefined` does in a spread, and is left out of every result.

use serde_json::{Map, Value};

/// `undefined` or `null` (`??` falls through both).
pub fn nullish(v: Option<&Value>) -> bool {
    v.is_none_or(Value::is_null)
}

/// The value unless it is nullish (`a ?? b` reads `defined(a).or(defined(b))`).
pub fn defined(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

/// `Object.assign(target, source)`; a `null` (undefined) source property removes the key.
pub fn assign(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (k, v) in source {
        if v.is_null() {
            target.remove(k);
        } else {
            target.insert(k.clone(), v.clone());
        }
    }
}

/// `{ ...a, ...b }` of two objects (anything else spreads nothing).
pub fn spread(a: &Value, b: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if let Value::Object(a) = a {
        assign(&mut out, a);
    }
    if let Value::Object(b) = b {
        assign(&mut out, b);
    }
    out
}

/// A copy of an object, or an empty one.
pub fn object(v: &Value) -> Map<String, Value> {
    spread(v, &Value::Null)
}

/// Object properties left `undefined` by the caller removed, at every depth (array items stay where they are).
pub fn strip_nulls(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|_, x| !x.is_null());
            m.values_mut().for_each(strip_nulls);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_nulls),
        _ => {}
    }
}

/// `v.field` as a string.
pub fn str_of<'a>(v: &'a Value, field: &str) -> Option<&'a str> {
    v.get(field).and_then(Value::as_str)
}

/// `v.field` as a number.
pub fn num_of(v: &Value, field: &str) -> Option<f64> {
    v.get(field).and_then(Value::as_f64)
}

/// `v.field` as an array (empty when missing).
pub fn arr_of<'a>(v: &'a Value, field: &str) -> &'a [Value] {
    v.get(field)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// JavaScript truthiness of a property value (`undefined`, `null`, `false`, `0`, `NaN` and `""` are falsy).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// A JavaScript number as JSON: an integer when it is one, so results print like `JSON.stringify` would.
pub fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spread_overrides_and_undefined_removes() {
        let a = json!({"x": 1, "y": 2, "z": {"k": 1}});
        let b = json!({"y": 3, "x": null, "w": [1]});
        assert_eq!(
            Value::Object(spread(&a, &b)),
            json!({"y": 3, "z": {"k": 1}, "w": [1]})
        );
        let mut v = json!({"a": null, "b": [{"c": null, "d": 1}, null]});
        strip_nulls(&mut v);
        assert_eq!(v, json!({"b": [{"d": 1}, null]}));
        assert_eq!(number(3.0).to_string(), "3");
        assert_eq!(number(0.5).to_string(), "0.5");
    }
}
