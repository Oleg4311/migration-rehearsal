# Политика безопасности

## Как сообщить об уязвимости

Пожалуйста, **не создавайте публичный issue**. Сообщите приватно через GitHub: вкладка **Security** → **Report a vulnerability**
([создать сообщение](https://github.com/Oleg4311/migration-rehearsal/security/advisories/new)).

Укажите, что именно не так, как это воспроизвести и какая версия затронута. Я постараюсь ответить в течение недели, но это проект одного человека, поэтому сроки не гарантирую.

## Поддерживаемые версии

Исправления выходят для последней версии: ветка `main` и последний релиз.

## Что считается уязвимостью

Инструмент выполняет SQL из вашей конфигурации на сервере, который вы указали. Интересны: выполнение SQL или команд за пределами созданных им баз `rehearsal_*`, обход защиты от подключения к не-локальному серверу, утечка строки подключения (пароля) в отчёт или вывод, внедрение разметки через имена файлов и текст выражений в отчёте.

## Что вне области

Сам факт, что миграции из вашей конфигурации выполняются на указанном сервере, — это назначение инструмента. Не запускайте его на боевой базе. Уже известные проблемы в зависимостях (их закрывает Dependabot) и отчёты без способа воспроизведения тоже вне области.

---

## English

Please report vulnerabilities privately via GitHub Security Advisories (**Security** → **Report a vulnerability**) and do not open a public issue. Include what is wrong, how to reproduce it and which version is affected. This is a one-person project, so response times are best-effort. Only the latest release and `main` receive fixes. The tool deliberately runs the SQL from your config on the server you point it at — never point it at production.
