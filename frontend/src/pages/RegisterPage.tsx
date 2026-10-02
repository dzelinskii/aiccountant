import {
  Alert,
  Anchor,
  Button,
  Container,
  Paper,
  PasswordInput,
  TextInput,
  Title,
} from '@mantine/core'
import { useForm } from '@mantine/form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { register } from '../api/auth'
import { ApiError } from '../api/client'
import { serverUrl, setServerUrl } from '../desktop/connection'
import { isDesktop } from '../desktop/runtime'

// в приложении сбой не от сервера (нет связи, опечатка в адресе, сбой хранилища
// ОС) общим «попробуйте ещё раз» не объяснить — показываем причину
function errorMessage(error: Error): string {
  if (error instanceof ApiError && error.status === 409) return 'Такой email уже зарегистрирован'
  // повтор тех же данных бесполезен, поэтому показываем, что сервер в них не принял
  if (error instanceof ApiError && error.status === 422 && error.message !== '') {
    return `Сервер отклонил данные: ${error.message}`
  }
  if (isDesktop() && !(error instanceof ApiError)) {
    return `Не удалось связаться с сервером — проверьте адрес. ${error.message}`
  }
  return 'Не удалось зарегистрироваться, попробуйте ещё раз'
}

export function RegisterPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm({
    initialValues: { server: isDesktop() ? serverUrl() : '', email: '', password: '' },
    validate: {
      server: (v) => (isDesktop() && v.trim() === '' ? 'Укажите адрес сервера' : null),
      email: (v) => (/^\S+@\S+$/.test(v) ? null : 'Некорректный email'),
      password: (v) => (v.length >= 8 ? null : 'Минимум 8 символов'),
    },
  })
  const mutation = useMutation({
    mutationFn: (values: { server: string; email: string; password: string }) => {
      // адрес нужен до запроса: он сам идёт на этот сервер
      if (isDesktop()) setServerUrl(values.server)
      return register(values.email, values.password)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate('/')
    },
  })

  return (
    <Container size={420} my={80}>
      <Title ta="center">Регистрация</Title>
      <Paper withBorder shadow="sm" p="lg" mt="lg" radius="md">
        <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
          {isDesktop() && (
            <TextInput label="Адрес сервера" mb="md" {...form.getInputProps('server')} />
          )}
          <TextInput label="Email" placeholder="you@example.com" {...form.getInputProps('email')} />
          <PasswordInput
            label="Пароль"
            description="Минимум 8 символов"
            mt="md"
            {...form.getInputProps('password')}
          />
          {mutation.isError && (
            <Alert color="red" mt="md">
              {errorMessage(mutation.error)}
            </Alert>
          )}
          <Button type="submit" fullWidth mt="xl" loading={mutation.isPending}>
            Создать аккаунт
          </Button>
        </form>
        <Anchor component={Link} to="/login" size="sm" mt="md" display="block" ta="center">
          Уже есть аккаунт? Войти
        </Anchor>
      </Paper>
    </Container>
  )
}
