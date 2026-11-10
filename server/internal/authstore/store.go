// Package authstore serves the web's Better Auth adapter. Better Auth keeps
// its password, session, 2FA, SSO, and SCIM logic in the web tier, but its rows
// live in the backend database; the web reaches them only through this store.
package authstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
)

// ErrInvalid reports a request naming an unknown model, field, or operator.
var ErrInvalid = errors.New("invalid auth store request")

// tables are the Better Auth models; no product table is reachable here.
var tables = map[string]bool{
	"account": true, "apikey": true, "invitation": true, "member": true, "organization": true,
	"scimProvider": true, "session": true, "ssoProvider": true, "twoFactor": true, "user": true,
	"verification": true,
	"oauthClient":  true, "oauthRefreshToken": true, "oauthAccessToken": true, "oauthConsent": true, "jwks": true,
}

type Where struct {
	Connector string `json:"connector"`
	Field     string `json:"field"`
	Mode      string `json:"mode"`
	Operator  string `json:"operator"`
	Value     any    `json:"value"`
}

type Request struct {
	ActorSessionID string             `json:"actorSessionId,omitempty"`
	Data           map[string]any     `json:"data"`
	Increment      map[string]float64 `json:"increment"`
	Limit          int                `json:"limit"`
	Model          string             `json:"model"`
	Offset         int                `json:"offset"`
	Op             string             `json:"op"`
	Select         []string           `json:"select"`
	SortBy         *struct {
		Direction string `json:"direction"`
		Field     string `json:"field"`
	} `json:"sortBy"`
	Where []Where `json:"where"`
}

// Result carries exactly one of a row, rows, or a count, by operation.
type Result struct {
	Count *int64           `json:"count,omitempty"`
	Row   map[string]any   `json:"row"`
	Rows  []map[string]any `json:"rows,omitempty"`
}

type executor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type Store struct {
	executor executor
	db       *sql.DB
	mu       sync.Mutex
	columns  map[string]map[string]string
}

func New(db *sql.DB) *Store { return &Store{db: db} }

// schema reads the live column types once, so the allowlist always matches the
// migrated tables instead of a hand-kept copy.
func (s *Store) schema(ctx context.Context) (map[string]map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.columns != nil {
		return s.columns, nil
	}
	rows, err := s.db.QueryContext(ctx, `SELECT table_name, column_name, data_type FROM information_schema.columns
		WHERE table_schema = current_schema()`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := map[string]map[string]string{}
	for rows.Next() {
		var table, column, kind string
		if err := rows.Scan(&table, &column, &kind); err != nil {
			return nil, err
		}
		if tables[table] {
			if columns[table] == nil {
				columns[table] = map[string]string{}
			}
			columns[table][column] = kind
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	s.columns = columns
	return columns, nil
}

func quote(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }

type query struct {
	args    []any
	columns map[string]string
	table   string
	guard   string
}

func (q *query) param(column string, value any) (string, error) {
	coerced, err := coerce(q.columns[column], value)
	if err != nil {
		return "", err
	}
	q.args = append(q.args, coerced)
	return fmt.Sprintf("$%d", len(q.args)), nil
}

func (q *query) field(name string) (string, error) {
	if _, ok := q.columns[name]; !ok {
		return "", fmt.Errorf("%w: field %q", ErrInvalid, name)
	}
	return quote(name), nil
}

// coerce converts a JSON value into the column's Go type. Better Auth sends
// dates as ISO strings because the adapter declares no native date support.
func coerce(kind string, value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	switch {
	case strings.HasPrefix(kind, "timestamp"):
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("%w: date value", ErrInvalid)
		}
		parsed, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			return nil, fmt.Errorf("%w: date value", ErrInvalid)
		}
		return parsed.UTC(), nil
	case kind == "integer" || kind == "bigint" || kind == "smallint":
		number, ok := value.(float64)
		if !ok || number != math.Trunc(number) {
			return nil, fmt.Errorf("%w: integer value", ErrInvalid)
		}
		return int64(number), nil
	case kind == "boolean":
		flag, ok := value.(bool)
		if !ok {
			return nil, fmt.Errorf("%w: boolean value", ErrInvalid)
		}
		return flag, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, fmt.Errorf("%w: text value", ErrInvalid)
	}
	return text, nil
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

func (q *query) clause(where Where) (string, error) {
	column, err := q.field(where.Field)
	if err != nil {
		return "", err
	}
	insensitive := where.Mode == "insensitive" && q.columns[where.Field] == "text"
	if insensitive {
		column = "lower(" + column + ")"
	}
	compare := func(operator string) (string, error) {
		value := where.Value
		if text, ok := value.(string); ok && insensitive {
			value = strings.ToLower(text)
		}
		placeholder, err := q.param(where.Field, value)
		return column + " " + operator + " " + placeholder, err
	}
	like := func(prefix, suffix string) (string, error) {
		text, ok := where.Value.(string)
		if !ok {
			return "", fmt.Errorf("%w: pattern value", ErrInvalid)
		}
		if insensitive {
			text = strings.ToLower(text)
		}
		q.args = append(q.args, prefix+escapeLike(text)+suffix)
		return fmt.Sprintf(`%s LIKE $%d ESCAPE '\'`, column, len(q.args)), nil
	}
	switch where.Operator {
	case "", "eq":
		if where.Value == nil {
			return column + " IS NULL", nil
		}
		return compare("=")
	case "ne":
		if where.Value == nil {
			return column + " IS NOT NULL", nil
		}
		return compare("<>")
	case "lt":
		return compare("<")
	case "lte":
		return compare("<=")
	case "gt":
		return compare(">")
	case "gte":
		return compare(">=")
	case "contains":
		return like("%", "%")
	case "starts_with":
		return like("", "%")
	case "ends_with":
		return like("%", "")
	case "in", "not_in":
		values, ok := where.Value.([]any)
		if !ok {
			return "", fmt.Errorf("%w: list value", ErrInvalid)
		}
		if len(values) == 0 {
			if where.Operator == "in" {
				return "FALSE", nil
			}
			return "TRUE", nil
		}
		placeholders := make([]string, len(values))
		for index, value := range values {
			if text, ok := value.(string); ok && insensitive {
				value = strings.ToLower(text)
			}
			placeholder, err := q.param(where.Field, value)
			if err != nil {
				return "", err
			}
			placeholders[index] = placeholder
		}
		operator := "IN"
		if where.Operator == "not_in" {
			operator = "NOT IN"
		}
		return column + " " + operator + " (" + strings.Join(placeholders, ", ") + ")", nil
	}
	return "", fmt.Errorf("%w: operator %q", ErrInvalid, where.Operator)
}

// filter matches the Prisma adapter: every AND clause holds, and at least one
// OR clause holds when any are given.
func (q *query) filter(where []Where) (string, error) {
	var and, or []string
	if q.guard != "" {
		and = append(and, q.guard)
	}
	for _, item := range where {
		clause, err := q.clause(item)
		if err != nil {
			return "", err
		}
		if item.Connector == "OR" {
			or = append(or, clause)
		} else {
			and = append(and, clause)
		}
	}
	if len(or) > 0 {
		and = append(and, "("+strings.Join(or, " OR ")+")")
	}
	if len(and) == 0 {
		return "TRUE", nil
	}
	return strings.Join(and, " AND "), nil
}

func (q *query) assignments(data map[string]any) ([]string, error) {
	sets := make([]string, 0, len(data))
	for name, value := range data {
		column, err := q.field(name)
		if err != nil {
			return nil, err
		}
		placeholder, err := q.param(name, value)
		if err != nil {
			return nil, err
		}
		sets = append(sets, column+" = "+placeholder)
	}
	return sets, nil
}

func (q *query) selection(fields []string) (string, error) {
	if len(fields) == 0 {
		return "*", nil
	}
	columns := make([]string, len(fields))
	for index, name := range fields {
		column, err := q.field(name)
		if err != nil {
			return "", err
		}
		columns[index] = column
	}
	return strings.Join(columns, ", "), nil
}

// Execute runs one adapter operation. Single-row writes lock exactly one
// matching row, so a non-unique filter never changes more than one record.
func (s *Store) Execute(ctx context.Context, request Request) (*Result, error) {
	request, err := scopeSCIMRequest(request)
	if err != nil {
		return nil, err
	}
	if !tables[request.Model] {
		return nil, fmt.Errorf("%w: model %q", ErrInvalid, request.Model)
	}
	schema, err := s.schema(ctx)
	if err != nil {
		return nil, err
	}
	if request.Model == "member" && request.Op != "findOne" && request.Op != "findMany" && request.Op != "count" && s.executor == nil {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		actor := ""
		if request.ActorSessionID != "" {
			if err = tx.QueryRowContext(ctx, `SELECT s."userId" FROM session s JOIN "user" u ON u.id=s."userId" WHERE s.id=$1 AND s."expiresAt">now() AND NOT coalesce(u.banned,false) FOR SHARE OF s,u`, request.ActorSessionID).Scan(&actor); err != nil {
				return nil, fmt.Errorf("%w: actor session is no longer active", ErrInvalid)
			}
		}
		if _, err = tx.ExecContext(ctx, `SELECT set_config('platform.activity_actor',$1,true)`, actor); err != nil {
			return nil, err
		}
		scoped := &Store{db: s.db, columns: schema, executor: tx}
		result, err := scoped.Execute(ctx, request)
		if err != nil {
			return nil, err
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return result, nil
	}
	q := &query{columns: schema[request.Model], table: quote(request.Model)}
	if (request.Model == "oauthRefreshToken" || request.Model == "oauthAccessToken") &&
		(request.Op == "findOne" || request.Op == "findMany" || request.Op == "count") {
		q.guard = fmt.Sprintf(`EXISTS (SELECT 1 FROM "session" s JOIN "user" u ON u.id=s."userId"
			WHERE s.id=%[1]s."sessionId" AND s."userId"=%[1]s."userId" AND s."expiresAt">now()
			AND (NOT coalesce(u.banned,false) OR u."banExpires"<now()))`, q.table)
	}
	switch request.Op {
	case "create":
		names, values := []string{}, []string{}
		for name, value := range request.Data {
			column, err := q.field(name)
			if err != nil {
				return nil, err
			}
			placeholder, err := q.param(name, value)
			if err != nil {
				return nil, err
			}
			names, values = append(names, column), append(values, placeholder)
		}
		if len(names) == 0 {
			return nil, fmt.Errorf("%w: empty create", ErrInvalid)
		}
		return s.one(ctx, fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s) RETURNING *", q.table,
			strings.Join(names, ", "), strings.Join(values, ", ")), q.args)
	case "findOne", "findMany":
		columns, err := q.selection(request.Select)
		if err != nil {
			return nil, err
		}
		filter, err := q.filter(request.Where)
		if err != nil {
			return nil, err
		}
		statement := fmt.Sprintf("SELECT %s FROM %s WHERE %s", columns, q.table, filter)
		if request.SortBy != nil {
			column, err := q.field(request.SortBy.Field)
			if err != nil {
				return nil, err
			}
			direction := "ASC"
			if strings.EqualFold(request.SortBy.Direction, "desc") {
				direction = "DESC"
			}
			statement += " ORDER BY " + column + " " + direction
		}
		if request.Op == "findOne" {
			return s.one(ctx, statement+" LIMIT 1", q.args)
		}
		if request.Limit > 0 {
			statement += fmt.Sprintf(" LIMIT %d", request.Limit)
		}
		if request.Offset > 0 {
			statement += fmt.Sprintf(" OFFSET %d", request.Offset)
		}
		rows, err := s.rows(ctx, statement, q.args)
		if err != nil {
			return nil, err
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		return &Result{Rows: rows}, nil
	case "count":
		filter, err := q.filter(request.Where)
		if err != nil {
			return nil, err
		}
		var count int64
		if err := s.runner().QueryRowContext(ctx, fmt.Sprintf("SELECT count(*) FROM %s WHERE %s", q.table, filter), q.args...).Scan(&count); err != nil {
			return nil, err
		}
		return &Result{Count: &count}, nil
	case "update", "incrementOne":
		sets, err := q.assignments(request.Data)
		if err != nil {
			return nil, err
		}
		for name, delta := range request.Increment {
			column, err := q.field(name)
			if err != nil {
				return nil, err
			}
			if delta != math.Trunc(delta) {
				return nil, fmt.Errorf("%w: increment", ErrInvalid)
			}
			q.args = append(q.args, int64(delta))
			sets = append(sets, fmt.Sprintf("%s = %s + $%d", column, column, len(q.args)))
		}
		if len(sets) == 0 {
			return nil, fmt.Errorf("%w: empty update", ErrInvalid)
		}
		filter, err := q.filter(request.Where)
		if err != nil {
			return nil, err
		}
		return s.one(ctx, fmt.Sprintf(`WITH target AS (SELECT ctid FROM %[1]s WHERE %[2]s LIMIT 1 FOR UPDATE)
			UPDATE %[1]s AS x SET %[3]s FROM target WHERE x.ctid = target.ctid RETURNING x.*`,
			q.table, filter, strings.Join(sets, ", ")), q.args)
	case "updateMany":
		sets, err := q.assignments(request.Data)
		if err != nil {
			return nil, err
		}
		if len(sets) == 0 {
			return nil, fmt.Errorf("%w: empty update", ErrInvalid)
		}
		filter, err := q.filter(request.Where)
		if err != nil {
			return nil, err
		}
		return s.affected(ctx, fmt.Sprintf("UPDATE %s SET %s WHERE %s", q.table, strings.Join(sets, ", "), filter), q.args)
	case "delete", "consumeOne":
		filter, err := q.filter(request.Where)
		if err != nil {
			return nil, err
		}
		return s.one(ctx, fmt.Sprintf(`DELETE FROM %[1]s WHERE ctid = (SELECT ctid FROM %[1]s WHERE %[2]s LIMIT 1 FOR UPDATE) RETURNING *`,
			q.table, filter), q.args)
	case "deleteMany":
		filter, err := q.filter(request.Where)
		if err != nil {
			return nil, err
		}
		return s.affected(ctx, fmt.Sprintf("DELETE FROM %s WHERE %s", q.table, filter), q.args)
	}
	return nil, fmt.Errorf("%w: operation %q", ErrInvalid, request.Op)
}

func (s *Store) affected(ctx context.Context, statement string, args []any) (*Result, error) {
	result, err := s.runner().ExecContext(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	return &Result{Count: &count}, nil
}

func (s *Store) one(ctx context.Context, statement string, args []any) (*Result, error) {
	rows, err := s.rows(ctx, statement, args)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return &Result{}, nil
	}
	return &Result{Row: rows[0]}, nil
}

func (s *Store) rows(ctx context.Context, statement string, args []any) ([]map[string]any, error) {
	rows, err := s.runner().QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var result []map[string]any
	for rows.Next() {
		values := make([]any, len(names))
		pointers := make([]any, len(names))
		for index := range values {
			pointers[index] = &values[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(names))
		for index, name := range names {
			switch value := values[index].(type) {
			case time.Time:
				row[name] = value.UTC().Format("2006-01-02T15:04:05.000Z07:00")
			case []byte:
				row[name] = string(value)
			default:
				row[name] = value
			}
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (s *Store) runner() executor {
	if s.executor != nil {
		return s.executor
	}
	return s.db
}
